package sub2api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/bejix/upstream-ops/backend/connector"
)

// ProbeSite 读 /api/v1/settings/public（无需登录）。
func (c *Client) ProbeSite(ctx context.Context, ch *connector.Channel) (*connector.SiteInfo, error) {
	body, err := c.getJSON(ctx, strings.TrimRight(ch.SiteURL, "/")+"/api/v1/settings/public", nil)
	if err != nil {
		return nil, fmt.Errorf("sub2api public settings: %w", err)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		return nil, errors.New("not a sub2api public settings response")
	}
	if _, ok := probe["turnstile_enabled"]; !ok {
		if _, ok := probe["site_name"]; !ok {
			return nil, errors.New("not a sub2api public settings response")
		}
	}
	var settings struct {
		SiteName              string `json:"site_name"`
		Version               string `json:"version"`
		TurnstileEnabled      bool   `json:"turnstile_enabled"`
		TurnstileSiteKey      string `json:"turnstile_site_key"`
		RegistrationEnabled   bool   `json:"registration_enabled"`
		LinuxDoConnectEnabled bool   `json:"linuxdo_connect_enabled"`
		OIDCEnabled           bool   `json:"oidc_enabled"`
		GitHubEnabled         bool   `json:"github_oauth_enabled"`
	}
	if err := json.Unmarshal(body, &settings); err != nil {
		return nil, fmt.Errorf("sub2api public settings decode: %w", err)
	}
	info := &connector.SiteInfo{
		Type:                 connector.TypeSub2API,
		SiteName:             strings.TrimSpace(settings.SiteName),
		Version:              strings.TrimSpace(settings.Version),
		TurnstileEnabled:     settings.TurnstileEnabled,
		TurnstileSiteKey:     settings.TurnstileSiteKey,
		RegistrationEnabled:  settings.RegistrationEnabled,
		PasswordLoginEnabled: true,
	}
	if settings.LinuxDoConnectEnabled {
		info.OAuthProviders = append(info.OAuthProviders, "linuxdo")
	}
	if settings.OIDCEnabled {
		info.OAuthProviders = append(info.OAuthProviders, "oidc")
	}
	if settings.GitHubEnabled {
		info.OAuthProviders = append(info.OAuthProviders, "github")
	}
	return info, nil
}

type sub2AvailablePricing struct {
	InputPrice      *float64 `json:"input_price"`
	OutputPrice     *float64 `json:"output_price"`
	PerRequestPrice *float64 `json:"per_request_price"`
}

type sub2AvailableChannel struct {
	Name      string `json:"name"`
	Platforms []struct {
		Platform string `json:"platform"`
		Groups   []struct {
			ID int64 `json:"id"`
		} `json:"groups"`
		SupportedModels []struct {
			Name     string                `json:"name"`
			Platform string                `json:"platform"`
			Pricing  *sub2AvailablePricing `json:"pricing"`
		} `json:"supported_models"`
	} `json:"platforms"`
}

// perMTok 把 Sub2API 的「每 token 美元价」换成「每百万 token」。
func perMTok(v *float64) *float64 {
	if v == nil {
		return nil
	}
	out := *v * 1_000_000
	return &out
}

// ListGroupCatalog：分组来自 /groups/available（含平台、订阅类型）+ /groups/rates（用户专属倍率）；
// 模型来自 /channels/available（站点需开启「可用渠道」展示，关闭时 models_known=false）。
func (c *Client) ListGroupCatalog(ctx context.Context, ch *connector.Channel, session *connector.AuthSession) ([]connector.GroupCatalog, error) {
	site := strings.TrimRight(ch.SiteURL, "/")
	body, err := c.getJSON(ctx, site+"/api/v1/groups/available", session)
	if err != nil {
		return nil, fmt.Errorf("sub2api groups: %w", err)
	}
	var raw []struct {
		ID               int64   `json:"id"`
		Name             string  `json:"name"`
		Description      string  `json:"description"`
		Platform         string  `json:"platform"`
		SubscriptionType string  `json:"subscription_type"`
		RateMultiplier   float64 `json:"rate_multiplier"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("sub2api groups decode: %w", err)
	}
	overrides := map[string]float64{}
	if ratesBody, err := c.getJSON(ctx, site+"/api/v1/groups/rates", session); err == nil {
		_ = json.Unmarshal(ratesBody, &overrides)
	}

	modelsByGroup := map[int64]map[string]connector.CatalogModel{}
	if chBody, err := c.getJSON(ctx, site+"/api/v1/channels/available", session); err == nil {
		var channels []sub2AvailableChannel
		if json.Unmarshal(chBody, &channels) == nil {
			for _, avail := range channels {
				for _, section := range avail.Platforms {
					for _, g := range section.Groups {
						set := modelsByGroup[g.ID]
						if set == nil {
							set = map[string]connector.CatalogModel{}
							modelsByGroup[g.ID] = set
						}
						for _, m := range section.SupportedModels {
							name := strings.TrimSpace(m.Name)
							if name == "" {
								continue
							}
							if _, seen := set[name]; seen {
								continue
							}
							cm := connector.CatalogModel{Name: name, Platform: firstNonEmpty(m.Platform, section.Platform)}
							if m.Pricing != nil {
								cm.InputPerMTok = perMTok(m.Pricing.InputPrice)
								cm.OutputPerMTok = perMTok(m.Pricing.OutputPrice)
								cm.PerRequest = m.Pricing.PerRequestPrice
							}
							set[name] = cm
						}
					}
				}
			}
		}
	}

	out := make([]connector.GroupCatalog, 0, len(raw))
	for _, item := range raw {
		id := item.ID
		ratio := item.RateMultiplier
		if v, ok := overrides[strconv.FormatInt(id, 10)]; ok {
			ratio = v
		}
		set, known := modelsByGroup[id]
		models := make([]connector.CatalogModel, 0, len(set))
		for _, m := range set {
			models = append(models, m)
		}
		sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
		out = append(out, connector.GroupCatalog{
			ID:               &id,
			Name:             item.Name,
			Description:      item.Description,
			Ratio:            ratio,
			Platform:         item.Platform,
			SubscriptionType: item.SubscriptionType,
			Models:           models,
			ModelsKnown:      known,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Platform != out[j].Platform {
			return out[i].Platform < out[j].Platform
		}
		if out[i].Ratio != out[j].Ratio {
			return out[i].Ratio < out[j].Ratio
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
