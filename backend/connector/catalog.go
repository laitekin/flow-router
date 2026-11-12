package connector

import "context"

// SiteInfo 是站点公开接口（无需登录）能拿到的基础信息，用于「贴个网址就自动识别」。
type SiteInfo struct {
	Type             ChannelType `json:"type"`
	SiteName         string      `json:"site_name,omitempty"`
	Version          string      `json:"version,omitempty"`
	TurnstileEnabled bool        `json:"turnstile_enabled"`
	// TurnstileSiteKey 只用于判断站点是否真的配置了 site key，不回显给前端以外的地方。
	TurnstileSiteKey     string `json:"-"`
	RegistrationEnabled  bool   `json:"registration_enabled"`
	PasswordLoginEnabled bool   `json:"password_login_enabled"`
	// OAuthProviders 站点开启的第三方登录（linuxdo / github / oidc …），提示用户该用 Token 模式。
	OAuthProviders []string `json:"oauth_providers,omitempty"`
}

// SiteProber 是 connector 的可选能力：探测站点公开信息。
// 返回 error 表示「看起来不是这个类型的站点」。
type SiteProber interface {
	ProbeSite(ctx context.Context, channel *Channel) (*SiteInfo, error)
}

// CatalogModel 分组下的一个可用模型。价格均为「分组倍率 = 1」时的基础价，单位 USD；
// 前端按分组倍率换算出实际价。未知字段为 nil。
type CatalogModel struct {
	Name     string `json:"name"`
	Platform string `json:"platform,omitempty"`
	// 按 token 计费：每百万 token 价格
	InputPerMTok  *float64 `json:"input_per_mtok,omitempty"`
	OutputPerMTok *float64 `json:"output_per_mtok,omitempty"`
	// 按次计费：每次请求价格
	PerRequest *float64 `json:"per_request,omitempty"`
}

// GroupCatalog 一个分组（= 上游的价格档）以及它下面能用的模型。
type GroupCatalog struct {
	ID               *int64         `json:"id,omitempty"`
	Name             string         `json:"name"`
	Description      string         `json:"description,omitempty"`
	Ratio            float64        `json:"ratio"`
	Platform         string         `json:"platform,omitempty"`
	SubscriptionType string         `json:"subscription_type,omitempty"`
	Models           []CatalogModel `json:"models"`
	// ModelsKnown=false 表示上游没有公开分组模型清单（例如 Sub2API 未开启「可用渠道」），
	// 前端应提示「需创建密钥后用 /v1/models 获取」而不是显示 0 个模型。
	ModelsKnown bool `json:"models_known"`
}

// GroupCatalogLister 是 connector 的可选能力：列出账号可用分组 + 分组价格 + 分组下的模型。
type GroupCatalogLister interface {
	ListGroupCatalog(ctx context.Context, channel *Channel, session *AuthSession) ([]GroupCatalog, error)
}
