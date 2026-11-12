package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/bejix/upstream-ops/backend/channel"
	"github.com/bejix/upstream-ops/backend/connector"
	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
)

// channelOnboarder 是「快速导入」用到的可选能力；channel.Service 实现了它。
// 单独成接口，避免已有测试里的 channelService stub 全部要补方法。
type channelOnboarder interface {
	DetectSite(ctx context.Context, rawURL string, typeHint storage.ChannelType, proxyEnabled bool) (*channel.DetectResult, error)
	PreviewChannel(ctx context.Context, in channel.CreateInput) (*channel.PreviewResult, error)
	AdoptPreviewSession(c *storage.Channel, in channel.CreateInput, ticket string) bool
	GroupCatalog(ctx context.Context, channelID uint) ([]connector.GroupCatalog, error)
}

var errOnboardUnsupported = errors.New("当前服务不支持快速导入")

func registerChannelOnboard(gp *gin.RouterGroup, d *Deps) {
	gp.POST("/detect", func(c *gin.Context) { detectChannelSite(c, d) })
	gp.POST("/preview", func(c *gin.Context) { previewChannel(c, d) })
	gp.GET("/:id/catalog", func(c *gin.Context) { channelCatalog(c, d) })
}

func onboarder(d *Deps) (channelOnboarder, bool) {
	o, ok := d.ChannelSvc.(channelOnboarder)
	return o, ok
}

type detectInput struct {
	SiteURL      string              `json:"site_url" binding:"required"`
	Type         storage.ChannelType `json:"type"`
	ProxyEnabled bool                `json:"proxy_enabled"`
}

func detectChannelSite(c *gin.Context, d *Deps) {
	var in detectInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	o, ok := onboarder(d)
	if !ok {
		fail(c, http.StatusNotImplemented, errOnboardUnsupported)
		return
	}
	res, err := o.DetectSite(c.Request.Context(), in.SiteURL, in.Type, in.ProxyEnabled)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

// previewInput 与 channelInput 的凭据字段一致，但不要求 name。
type previewInput struct {
	Type             storage.ChannelType    `json:"type" binding:"required"`
	SiteURL          string                 `json:"site_url" binding:"required"`
	Username         string                 `json:"username"`
	Password         string                 `json:"password"`
	CredentialMode   storage.CredentialMode `json:"credential_mode"`
	TokenCredential  string                 `json:"token_credential"`
	LoginExtraParams string                 `json:"login_extra_params"`
	TurnstileEnabled bool                   `json:"turnstile_enabled"`
	ProxyEnabled     bool                   `json:"proxy_enabled"`
	CaptchaConfigID  *uint                  `json:"captcha_config_id"`
}

func (in previewInput) toCreateInput() channel.CreateInput {
	return channel.CreateInput{
		Type:             in.Type,
		SiteURL:          strings.TrimSpace(in.SiteURL),
		Username:         strings.TrimSpace(in.Username),
		Password:         in.Password,
		CredentialMode:   in.CredentialMode,
		TokenCredential:  in.TokenCredential,
		LoginExtraParams: in.LoginExtraParams,
		TurnstileEnabled: in.TurnstileEnabled,
		ProxyEnabled:     in.ProxyEnabled,
		CaptchaConfigID:  in.CaptchaConfigID,
	}
}

func previewChannel(c *gin.Context, d *Deps) {
	var in previewInput
	if err := c.ShouldBindJSON(&in); err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	o, ok := onboarder(d)
	if !ok {
		fail(c, http.StatusNotImplemented, errOnboardUnsupported)
		return
	}
	res, err := o.PreviewChannel(c.Request.Context(), in.toCreateInput())
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": res})
}

func channelCatalog(c *gin.Context, d *Deps) {
	id, err := uintParam(c, "id")
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	o, ok := onboarder(d)
	if !ok {
		fail(c, http.StatusNotImplemented, errOnboardUnsupported)
		return
	}
	groups, err := o.GroupCatalog(c.Request.Context(), id)
	if err != nil {
		fail(c, http.StatusBadRequest, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": groups})
}
