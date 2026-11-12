package channel

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/connector"
	"github.com/bejix/upstream-ops/backend/storage"
)

// 「快速导入」相关：贴网址自动识别站点 → 连接预览（余额 / 分组 / 分组价 / 分组模型）→ 保存。
//
// 预览会真实登录一次（可能消耗一次打码）。为了保存时不再登录第二次，预览成功后把会话
// 放进内存票据（previewTicketTTL 内有效），创建渠道时带上 ticket 直接落库复用。

const previewTicketTTL = 15 * time.Minute

type previewTicket struct {
	fingerprint string
	session     *connector.AuthSession
	refreshed   bool // token 模式下预览过程中 refresh 过（旧 refresh_token 可能已轮换）
	expiresAt   time.Time
}

// NormalizeSiteURL 把用户随手贴的地址整理成站点根地址：
// 补 https://、去掉路径 / 查询（例如 https://x.com/login?redirect=... → https://x.com）。
func NormalizeSiteURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("站点地址不能为空")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("站点地址无效：%s", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("站点地址只支持 http / https：%s", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}

// DetectResult 站点识别结果。
type DetectResult struct {
	SiteURL string              `json:"site_url"`
	Site    *connector.SiteInfo `json:"site"`
	// Error 识别失败原因；失败时仍返回规范化后的 SiteURL，前端可让用户手动选类型继续。
	Error string `json:"error,omitempty"`
}

// DetectSite 依次尝试 Sub2API / NewAPI 的公开接口，识别站点类型与是否开启 Turnstile。
// typeHint 非空时只试该类型。
func (s *Service) DetectSite(ctx context.Context, rawURL string, typeHint storage.ChannelType, proxyEnabled bool) (*DetectResult, error) {
	res, err := s.detectSite(ctx, rawURL, typeHint, proxyEnabled)
	if err != nil || res.Site != nil || strings.Contains(rawURL, "://") {
		return res, err
	}
	// 用户没写协议时默认 https；探测失败再试一次 http（内网 / 自建站点常见）。
	if alt, altErr := s.detectSite(ctx, "http://"+strings.TrimSpace(rawURL), typeHint, proxyEnabled); altErr == nil && alt.Site != nil {
		return alt, nil
	}
	return res, nil
}

func (s *Service) detectSite(ctx context.Context, rawURL string, typeHint storage.ChannelType, proxyEnabled bool) (*DetectResult, error) {
	site, err := NormalizeSiteURL(rawURL)
	if err != nil {
		return nil, err
	}
	resolved := &connector.Channel{SiteURL: site}
	if proxyEnabled {
		proxyURL, err := s.proxyURL()
		if err != nil {
			return nil, err
		}
		resolved.ProxyURL = proxyURL
	}
	order := []connector.ChannelType{connector.TypeSub2API, connector.TypeNewAPI}
	if typeHint != "" {
		order = []connector.ChannelType{connector.ChannelType(typeHint)}
	}
	var errs []string
	for _, t := range order {
		conn, err := connector.For(t)
		if err != nil {
			return nil, err
		}
		prober, ok := conn.(connector.SiteProber)
		if !ok {
			continue
		}
		s.applyHTTPConfig(conn)
		applyProxy(conn, resolved)
		probeCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		info, err := prober.ProbeSite(probeCtx, resolved)
		cancel()
		if err == nil {
			// 开了 Turnstile 但没配 site key 时上游实际不会校验，按未开启处理。
			if info.TurnstileEnabled && strings.TrimSpace(info.TurnstileSiteKey) == "" {
				info.TurnstileEnabled = false
			}
			return &DetectResult{SiteURL: site, Site: info}, nil
		}
		errs = append(errs, fmt.Sprintf("%s: %v", t, err))
	}
	return &DetectResult{SiteURL: site, Error: fmt.Sprintf("无法识别站点类型（%s）", strings.Join(errs, "；"))}, nil
}

// PreviewResult 连接预览结果。Ticket 用于创建时复用本次登录会话。
type PreviewResult struct {
	Ticket          string                   `json:"ticket"`
	TicketExpiresAt time.Time                `json:"ticket_expires_at"`
	SiteURL         string                   `json:"site_url"`
	UserID          string                   `json:"user_id,omitempty"`
	Balance         *float64                 `json:"balance,omitempty"`
	BalanceError    string                   `json:"balance_error,omitempty"`
	Groups          []connector.GroupCatalog `json:"groups"`
	GroupsError     string                   `json:"groups_error,omitempty"`
}

// PreviewChannel 用表单里的明文凭据临时登录一次（不落库），返回余额 + 分组目录。
func (s *Service) PreviewChannel(ctx context.Context, in CreateInput) (*PreviewResult, error) {
	site, err := NormalizeSiteURL(in.SiteURL)
	if err != nil {
		return nil, err
	}
	in.SiteURL = site
	c, err := s.transientChannel(in)
	if err != nil {
		return nil, err
	}
	resolved, err := s.Resolve(ctx, c)
	if err != nil {
		return nil, err
	}
	conn, err := connector.For(connector.ChannelType(c.Type))
	if err != nil {
		return nil, err
	}
	s.applyHTTPConfig(conn)
	applyProxy(conn, resolved)

	session, refreshed, err := s.transientSession(ctx, c, resolved, conn)
	if err != nil {
		return nil, err
	}
	out := &PreviewResult{SiteURL: site, UserID: session.UserID}
	if bal, err := conn.GetBalance(ctx, resolved, session); err != nil {
		out.BalanceError = err.Error()
	} else {
		v := bal.Balance
		out.Balance = &v
	}
	groups, err := listGroupCatalog(ctx, conn, resolved, session)
	if err != nil {
		out.GroupsError = err.Error()
		out.Groups = []connector.GroupCatalog{}
	} else {
		out.Groups = groups
	}

	ticket := randomTicket()
	expires := time.Now().Add(previewTicketTTL)
	s.previewTickets.Store(ticket, &previewTicket{
		fingerprint: previewFingerprint(in),
		session:     session,
		refreshed:   refreshed,
		expiresAt:   expires,
	})
	s.sweepPreviewTickets()
	out.Ticket = ticket
	out.TicketExpiresAt = expires
	return out, nil
}

// AdoptPreviewSession 在渠道创建后调用：ticket 与渠道凭据一致时直接落库预览时拿到的会话，
// 省去第二次登录（和第二次打码）。任何不匹配都静默忽略，走正常的首次登录流程。
func (s *Service) AdoptPreviewSession(c *storage.Channel, in CreateInput, ticket string) bool {
	ticket = strings.TrimSpace(ticket)
	if ticket == "" || c == nil {
		return false
	}
	v, ok := s.previewTickets.LoadAndDelete(ticket)
	if !ok {
		return false
	}
	t := v.(*previewTicket)
	in.SiteURL = c.SiteURL
	if time.Now().After(t.expiresAt) || t.fingerprint != previewFingerprint(in) {
		return false
	}
	if c.CredentialMode == storage.CredentialModeToken {
		if t.refreshed {
			// 预览时用 refresh_token 换过新 token：把新凭据写回，避免旧 refresh_token 已被轮换。
			return s.persistTokenCredential(c, t.session) == nil
		}
		return true
	}
	return s.persistSession(c.ID, t.session) == nil
}

// GroupCatalog 已保存渠道的分组目录（分组 + 价格 + 模型）。
func (s *Service) GroupCatalog(ctx context.Context, channelID uint) ([]connector.GroupCatalog, error) {
	c, resolved, conn, session, err := s.prepareConnectorCall(ctx, channelID)
	if err != nil {
		return nil, err
	}
	groups, err := listGroupCatalog(ctx, conn, resolved, session)
	if err != nil {
		return nil, err
	}
	_ = s.Channels.SetLastError(c.ID, "")
	return groups, nil
}

func listGroupCatalog(ctx context.Context, conn connector.Connector, resolved *connector.Channel, session *connector.AuthSession) ([]connector.GroupCatalog, error) {
	if lister, ok := conn.(connector.GroupCatalogLister); ok {
		return lister.ListGroupCatalog(ctx, resolved, session)
	}
	groups, err := conn.ListAPIKeyGroups(ctx, resolved, session)
	if err != nil {
		return nil, err
	}
	out := make([]connector.GroupCatalog, 0, len(groups))
	for _, g := range groups {
		out = append(out, connector.GroupCatalog{
			ID: g.ID, Name: g.Name, Description: g.Description, Ratio: g.Ratio,
			Models: []connector.CatalogModel{},
		})
	}
	return out, nil
}

// transientChannel 用 CreateInput 构造一个不落库的 storage.Channel（ID=0），复用 Resolve 等现有逻辑。
func (s *Service) transientChannel(in CreateInput) (*storage.Channel, error) {
	if in.Type != storage.ChannelTypeNewAPI && in.Type != storage.ChannelTypeSub2API {
		return nil, fmt.Errorf("未知渠道类型：%s", in.Type)
	}
	mode := in.CredentialMode
	if mode == "" {
		mode = storage.CredentialModePassword
	}
	rawCred, err := selectRawCredential(mode, in.Password, in.TokenCredential)
	if err != nil {
		return nil, err
	}
	if err := validateCredential(in.Type, mode, rawCred); err != nil {
		return nil, err
	}
	loginExtraParams, err := normalizeLoginExtraParams(in.LoginExtraParams)
	if err != nil {
		return nil, err
	}
	enc, err := s.Cipher.Encrypt(rawCred)
	if err != nil {
		return nil, fmt.Errorf("encrypt credential: %w", err)
	}
	c := &storage.Channel{
		Name:             in.Name,
		Type:             in.Type,
		SiteURL:          in.SiteURL,
		Username:         in.Username,
		PasswordCipher:   enc,
		CredentialMode:   mode,
		LoginExtraParams: loginExtraParams,
		TurnstileEnabled: in.TurnstileEnabled && mode == storage.CredentialModePassword,
		ProxyEnabled:     in.ProxyEnabled,
		CaptchaConfigID:  in.CaptchaConfigID,
	}
	if mode == storage.CredentialModeToken {
		c.CaptchaConfigID = nil
	}
	return c, nil
}

// transientSession 与 EnsureSession / login 同语义，但不写 AuthSessions、MonitorLogs、last_error。
func (s *Service) transientSession(
	ctx context.Context,
	c *storage.Channel,
	resolved *connector.Channel,
	conn connector.Connector,
) (*connector.AuthSession, bool, error) {
	if c.CredentialMode == storage.CredentialModeToken {
		session, err := s.buildSessionFromToken(c)
		if err != nil {
			return nil, false, err
		}
		checkErr := conn.CheckAuth(ctx, resolved, session)
		if checkErr == nil {
			return session, false, nil
		}
		if strings.TrimSpace(session.RefreshToken) != "" {
			refreshed, err := refreshSession(ctx, resolved, conn, session)
			if err == nil {
				if err := conn.CheckAuth(ctx, resolved, refreshed); err == nil {
					return refreshed, true, nil
				}
			}
		}
		return nil, false, fmt.Errorf("token 无效或已过期：%w", checkErr)
	}

	if c.TurnstileEnabled && c.CaptchaConfigID == nil {
		return nil, false, errors.New("站点开启了 Turnstile 人机验证：请选择打码 provider，或改用「浏览器导入 / Token」方式跳过登录")
	}
	if err := s.prepareTurnstile(ctx, c, resolved, conn); err != nil {
		return nil, false, err
	}
	session, err := conn.Login(ctx, resolved)
	if err != nil {
		return nil, false, explainLoginError(err, c.TurnstileEnabled)
	}
	if err := conn.CheckAuth(ctx, resolved, session); err != nil {
		return nil, false, fmt.Errorf("登录后鉴权失败：%w", err)
	}
	return session, false, nil
}

// explainLoginError 给常见登录失败补一句「下一步该怎么办」。
func explainLoginError(err error, turnstileEnabled bool) error {
	msg := strings.ToLower(err.Error())
	if !turnstileEnabled && (strings.Contains(msg, "turnstile") || strings.Contains(msg, "captcha") || strings.Contains(msg, "人机")) {
		return fmt.Errorf("%w（站点要求人机验证：打开 Turnstile 并选择打码 provider，或改用浏览器导入）", err)
	}
	if strings.Contains(msg, "2fa") {
		return fmt.Errorf("%w（账号开启了两步验证，建议改用浏览器导入 / Token 方式）", err)
	}
	return err
}

func previewFingerprint(in CreateInput) string {
	mode := in.CredentialMode
	if mode == "" {
		mode = storage.CredentialModePassword
	}
	cred := in.Password
	if mode == storage.CredentialModeToken {
		cred = in.TokenCredential
	}
	return strings.Join([]string{
		string(in.Type),
		strings.TrimRight(strings.TrimSpace(in.SiteURL), "/"),
		string(mode),
		strings.TrimSpace(in.Username),
		cred,
	}, "\x00")
}

func randomTicket() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (s *Service) sweepPreviewTickets() {
	now := time.Now()
	s.previewTickets.Range(func(k, v any) bool {
		if t, ok := v.(*previewTicket); ok && now.After(t.expiresAt) {
			s.previewTickets.Delete(k)
		}
		return true
	})
}
