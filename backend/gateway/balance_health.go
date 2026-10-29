package gateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
)

// Only explicit billing exhaustion is retryable; generic auth/permission errors
// and rate limits must not be mistaken for an exhausted account.
func isBalanceExhausted(status int, body []byte) bool {
	if status < 400 || status > 599 || len(body) > 64*1024 {
		return false
	}
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return false
	}
	var values []string
	var fields func(map[string]any)
	fields = func(m map[string]any) {
		for _, key := range []string{"code", "type", "message", "detail"} {
			if s, ok := m[key].(string); ok {
				values = append(values, s)
			}
		}
	}
	fields(root)
	switch e := root["error"].(type) {
	case map[string]any:
		fields(e)
	case string:
		values = append(values, e)
	}
	for _, value := range values {
		s := strings.ToLower(strings.TrimSpace(value))
		switch s {
		case "insufficient_balance", "insufficient_quota", "account_balance_insufficient", "balance_exhausted", "credits_exhausted", "credit_balance_too_low", "quota_exhausted", "account_quota_exhausted", "billing_hard_limit_reached":
			return true
		}
		for _, phrase := range []string{"insufficient account balance", "insufficient balance", "credit balance is too low", "insufficient quota", "account quota exhausted", "exceeded your current quota", "quota has been exhausted", "余额不足", "余额已耗尽", "额度已用尽", "账户额度不足"} {
			if strings.Contains(s, phrase) {
				return true
			}
		}
	}
	return false
}

func credentialScope(target *upstreamTarget) string {
	if target == nil || target.APIKey == "" {
		return ""
	}
	base := strings.TrimRight(target.BaseURL, "/")
	if u, err := url.Parse(base); err == nil {
		u.Host = strings.ToLower(u.Host)
		base = u.String()
	}
	h := sha256.Sum256([]byte(base + "\x00" + target.APIKey))
	return hex.EncodeToString(h[:])
}

// Called both at ingress and again before failover, so duplicate credentials
// cannot be hit via another route after becoming insolvent during this request.
func (rt *Runtime) filterCredentialCooldowns(c *gin.Context, routes []storage.GatewayRoute, audit *failoverAudit) ([]storage.GatewayRoute, bool) {
	scopes := []string{}
	byRoute := map[uint]string{}
	for _, route := range routes {
		if !IsRouteSchedulable(&route, time.Now()) {
			continue
		}
		if target, err := rt.resolveUpstreamTarget(&route); err == nil {
			scope := credentialScope(target)
			byRoute[route.ID] = scope
			scopes = append(scopes, scope)
		}
	}
	rows, err := rt.Routes.CredentialCooldowns(scopes, time.Now())
	if err != nil {
		if rt.Log != nil {
			rt.Log.Error("read credential cooldown failed", "request_id", audit.RequestID, "err", err)
		}
		return nil, false
	}
	out := make([]storage.GatewayRoute, 0, len(routes))
	var earliest time.Time
	for _, route := range routes {
		if row, ok := rows[byRoute[route.ID]]; ok {
			if earliest.IsZero() || row.Until.Before(earliest) {
				earliest = row.Until
			}
			rt.logFailoverDecision(audit, "skip", "credential_cooling_down", route.ID)
			continue
		}
		out = append(out, route)
	}
	if len(out) == 0 && !earliest.IsZero() {
		seconds := int(math.Ceil(time.Until(earliest).Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		c.Header("Retry-After", fmt.Sprint(seconds))
	}
	return out, true
}

func (rt *Runtime) coolCredential(target *upstreamTarget, routeID uint, reqID string, group *storage.GatewayGroup) *time.Time {
	var providerID uint
	if target != nil && target.Provider != nil {
		providerID = target.Provider.ID
	}
	row, err := rt.Routes.NoteCredentialFailure(credentialScope(target), routeID, providerID, reqID,
		time.Duration(group.BalanceCooldownSeconds)*time.Second, time.Duration(group.BalanceCooldownMaxSeconds)*time.Second, time.Now())
	if err != nil {
		if rt.Log != nil {
			rt.Log.Error("write credential cooldown failed", "request_id", reqID, "route_id", routeID, "err", err)
		}
		return nil
	}
	if row == nil {
		return nil
	}
	if rt.Log != nil {
		rt.Log.Warn("gateway credential cooldown started", "request_id", reqID, "route_id", routeID, "provider_id", providerID, "failure_class", "balance_exhausted", "failures", row.Failures, "cooldown_until", row.Until)
	}
	return &row.Until
}
