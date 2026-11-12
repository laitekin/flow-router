package newapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/bejix/upstream-ops/backend/connector"
)

// ProbeSite 读 /api/status（无需登录）。能解析出 NewAPI 的 status 结构就认为是 NewAPI 站点。
func (c *Client) ProbeSite(ctx context.Context, ch *connector.Channel) (*connector.SiteInfo, error) {
	body, err := c.getRaw(ctx, strings.TrimRight(ch.SiteURL, "/")+"/api/status", nil)
	if err != nil {
		return nil, fmt.Errorf("newapi status: %w", err)
	}
	var wrapped struct {
		Success *bool           `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil || wrapped.Success == nil || len(wrapped.Data) == 0 {
		return nil, errors.New("not a newapi /api/status response")
	}
	var status struct {
		SystemName              string   `json:"system_name"`
		Version                 string   `json:"version"`
		QuotaPerUnit            *float64 `json:"quota_per_unit"`
		TurnstileCheck          bool     `json:"turnstile_check"`
		TurnstileSiteKey        string   `json:"turnstile_site_key"`
		RegisterEnabled         *bool    `json:"register_enabled"`
		PasswordLoginEnabled    *bool    `json:"password_login_enabled"`
		GitHubOAuth             bool     `json:"github_oauth"`
		LinuxDOOAuth            bool     `json:"linuxdo_oauth"`
		OIDCEnabled             bool     `json:"oidc_enabled"`
		WeChatLogin             bool     `json:"wechat_login"`
		TelegramOAuth           bool     `json:"telegram_oauth"`
		DiscordOAuth            bool     `json:"discord_oauth"`
		PasswordRegisterEnabled *bool    `json:"password_register_enabled"`
	}
	if err := json.Unmarshal(wrapped.Data, &status); err != nil {
		return nil, fmt.Errorf("newapi status decode: %w", err)
	}
	// /api/status 太常见了，至少要有一个 NewAPI 特有字段才认。
	if status.QuotaPerUnit == nil && status.SystemName == "" && status.Version == "" {
		return nil, errors.New("not a newapi /api/status response")
	}
	info := &connector.SiteInfo{
		Type:                 connector.TypeNewAPI,
		SiteName:             strings.TrimSpace(status.SystemName),
		Version:              strings.TrimSpace(status.Version),
		TurnstileEnabled:     status.TurnstileCheck,
		TurnstileSiteKey:     status.TurnstileSiteKey,
		RegistrationEnabled:  status.RegisterEnabled == nil || *status.RegisterEnabled,
		PasswordLoginEnabled: status.PasswordLoginEnabled == nil || *status.PasswordLoginEnabled,
	}
	for name, on := range map[string]bool{
		"github": status.GitHubOAuth, "linuxdo": status.LinuxDOOAuth, "oidc": status.OIDCEnabled,
		"wechat": status.WeChatLogin, "telegram": status.TelegramOAuth, "discord": status.DiscordOAuth,
	} {
		if on {
			info.OAuthProviders = append(info.OAuthProviders, name)
		}
	}
	sort.Strings(info.OAuthProviders)
	return info, nil
}

// newAPIPricingItem 是 /api/pricing 的一条。quota_type 0 = 按量（倍率），1 = 按次（固定价）。
type newAPIPricingItem struct {
	ModelName       string   `json:"model_name"`
	QuotaType       int      `json:"quota_type"`
	ModelRatio      float64  `json:"model_ratio"`
	ModelPrice      float64  `json:"model_price"`
	CompletionRatio float64  `json:"completion_ratio"`
	EnableGroups    []string `json:"enable_groups"`
}

// newAPIRatioUSDPerMTok：NewAPI 模型倍率 1 = $0.002 / 1K token = $2 / 1M token。
const newAPIRatioUSDPerMTok = 2.0

func (p newAPIPricingItem) toCatalogModel() connector.CatalogModel {
	m := connector.CatalogModel{Name: p.ModelName}
	if p.QuotaType == 1 {
		price := p.ModelPrice
		m.PerRequest = &price
		return m
	}
	in := round4(p.ModelRatio * newAPIRatioUSDPerMTok)
	m.InputPerMTok = &in
	completion := p.CompletionRatio
	if completion <= 0 {
		completion = 1
	}
	out := round4(p.ModelRatio * completion * newAPIRatioUSDPerMTok)
	m.OutputPerMTok = &out
	return m
}

// ListGroupCatalog：分组 + 倍率来自 /api/user/self/groups（用户实际可用、含专属倍率）；
// 模型来自 /api/pricing 的 enable_groups。/api/pricing 不可用时仍返回分组，只是 models_known=false。
func (c *Client) ListGroupCatalog(ctx context.Context, ch *connector.Channel, session *connector.AuthSession) ([]connector.GroupCatalog, error) {
	site := strings.TrimRight(ch.SiteURL, "/")
	groups, groupErr := c.newAPIGroupMap(ctx, ch, session)

	var pricing struct {
		Success     bool                `json:"success"`
		Message     string              `json:"message"`
		Data        []newAPIPricingItem `json:"data"`
		GroupRatio  map[string]float64  `json:"group_ratio"`
		UsableGroup map[string]string   `json:"usable_group"`
	}
	pricingOK := false
	if body, err := c.getRaw(ctx, site+"/api/pricing", session); err == nil {
		if json.Unmarshal(body, &pricing) == nil && pricing.Success {
			pricingOK = true
		}
	}
	if groupErr != nil && !pricingOK {
		return nil, groupErr
	}
	if groups == nil {
		groups = map[string]connector.APIKeyGroup{}
	}
	if len(groups) == 0 && pricingOK {
		for name, desc := range pricing.UsableGroup {
			ratio, ok := pricing.GroupRatio[name]
			if !ok {
				ratio = 1
			}
			groups[name] = connector.APIKeyGroup{Name: name, Description: desc, Ratio: ratio}
		}
	}

	byGroup := map[string][]connector.CatalogModel{}
	if pricingOK {
		for _, item := range pricing.Data {
			if strings.TrimSpace(item.ModelName) == "" {
				continue
			}
			model := item.toCatalogModel()
			targets := item.EnableGroups
			if len(targets) == 0 || containsFold(targets, "all") {
				targets = make([]string, 0, len(groups))
				for name := range groups {
					targets = append(targets, name)
				}
			}
			for _, g := range targets {
				byGroup[g] = append(byGroup[g], model)
			}
		}
	}

	out := make([]connector.GroupCatalog, 0, len(groups))
	for name, g := range groups {
		models := byGroup[name]
		sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
		if models == nil {
			models = []connector.CatalogModel{}
		}
		out = append(out, connector.GroupCatalog{
			Name:        name,
			Description: g.Description,
			Ratio:       g.Ratio,
			Models:      models,
			ModelsKnown: pricingOK,
		})
	}
	sortCatalog(out)
	return out, nil
}

func sortCatalog(out []connector.GroupCatalog) {
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Ratio != out[j].Ratio {
			return out[i].Ratio < out[j].Ratio
		}
		return out[i].Name < out[j].Name
	})
}

func containsFold(list []string, v string) bool {
	for _, s := range list {
		if strings.EqualFold(strings.TrimSpace(s), v) {
			return true
		}
	}
	return false
}
