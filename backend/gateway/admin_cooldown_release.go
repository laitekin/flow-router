// 管理面：查看路由当前的各类冷却，并「解除冷却并测试」。
//
// 路由可能同时处于三种互相独立的冷却：
//   - 路由暂停（temp_unschedulable_until）：普通失败触发，「清除暂停」处理；
//   - 密钥冷却（gateway_credential_cooldowns）：余额不足触发，按 端点+凭据 摘要跨路由/分组共享；
//   - 模型冷却（gateway_model_cooldowns）：某路由上某模型的健康失败。
//
// 「解除冷却并测试」先绕过冷却直接探测上游，成功后才解除，失败则保留冷却并返回具体原因，
// 避免手动解除后真实流量再次撞上仍然欠费/失效的凭据。
package gateway

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
)

// releaseMaxModels 单次「解除并测试」最多探测的冷却模型数。
const releaseMaxModels = 5

// RouteCredentialCooldown 路由所用凭据的密钥冷却（不返回凭据或摘要）。
type RouteCredentialCooldown struct {
	Until         time.Time `json:"until"`
	Failures      int       `json:"failures"`
	Reason        string    `json:"reason"`
	RequestID     string    `json:"request_id,omitempty"`
	LastFailureAt time.Time `json:"last_failure_at"`
	// TriggerRouteID 触发冷却的路由；可能是共享同一凭据的其它路由。
	TriggerRouteID uint `json:"trigger_route_id,omitempty"`
}

// RouteModelCooldown 路由上单个模型的冷却。
type RouteModelCooldown struct {
	Model     string    `json:"model"`
	Until     time.Time `json:"until"`
	Failures  int       `json:"failures"`
	Reason    string    `json:"reason,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
}

// RouteCooldownState 单条路由当前仍生效的冷却汇总。
type RouteCooldownState struct {
	RouteID    uint                     `json:"route_id"`
	PauseUntil *time.Time               `json:"pause_until,omitempty"`
	Credential *RouteCredentialCooldown `json:"credential,omitempty"`
	Models     []RouteModelCooldown     `json:"models,omitempty"`
}

// Active 是否仍有任一冷却生效。
func (s *RouteCooldownState) Active() bool {
	return s != nil && (s.PauseUntil != nil || s.Credential != nil || len(s.Models) > 0)
}

// ReleaseCooldownInput 「解除冷却并测试」参数。
type ReleaseCooldownInput struct {
	// Model 指定测试模型；为空时测试该路由上冷却中的模型，没有则取组内该路由可用的第一个模型。
	Model string `json:"model"`
}

// ReleaseCooldownResult 测试结果与解除情况。
type ReleaseCooldownResult struct {
	// Released 至少一个测试成功，且已解除路由暂停与密钥冷却。
	Released bool              `json:"released"`
	Tests    []ModelTestResult `json:"tests"`
	// Cleared* 本次实际解除的冷却。
	ClearedPause      bool     `json:"cleared_pause"`
	ClearedCredential bool     `json:"cleared_credential"`
	ClearedModels     []string `json:"cleared_models,omitempty"`
	// Remaining 处理后仍生效的冷却，便于界面刷新状态。
	Remaining *RouteCooldownState `json:"remaining,omitempty"`
}

// RouteCooldowns 返回组内各路由仍生效的冷却；无冷却的路由不返回。
func (a *AdminService) RouteCooldowns(groupID uint) ([]RouteCooldownState, error) {
	routes, err := a.Routes.ListByGroupID(groupID)
	if err != nil {
		return nil, err
	}
	return a.routeCooldownStates(routes, time.Now())
}

func (a *AdminService) routeCooldownStates(routes []storage.GatewayRoute, now time.Time) ([]RouteCooldownState, error) {
	if len(routes) == 0 {
		return []RouteCooldownState{}, nil
	}
	ids := make([]uint, 0, len(routes))
	scopeByRoute := make(map[uint]string, len(routes))
	scopes := make([]string, 0, len(routes))
	for i := range routes {
		ids = append(ids, routes[i].ID)
		if target, err := a.resolveUpstreamTarget(&routes[i]); err == nil {
			if scope := credentialScope(target); scope != "" {
				scopeByRoute[routes[i].ID] = scope
				scopes = append(scopes, scope)
			}
		}
	}
	creds, err := a.Routes.CredentialCooldowns(scopes, now)
	if err != nil {
		return nil, err
	}
	models, err := a.Routes.ActiveModelCooldownsForRoutes(ids, now)
	if err != nil {
		return nil, err
	}
	modelsByRoute := map[uint][]RouteModelCooldown{}
	for _, m := range models {
		modelsByRoute[m.RouteID] = append(modelsByRoute[m.RouteID], RouteModelCooldown{
			Model: m.Model, Until: m.Until, Failures: m.Failures, Reason: m.Reason, RequestID: m.RequestID,
		})
	}
	out := make([]RouteCooldownState, 0)
	for _, r := range routes {
		st := RouteCooldownState{RouteID: r.ID, Models: modelsByRoute[r.ID]}
		if r.TempUnschedulableUntil != nil && r.TempUnschedulableUntil.After(now) {
			until := *r.TempUnschedulableUntil
			st.PauseUntil = &until
		}
		if row, ok := creds[scopeByRoute[r.ID]]; ok {
			st.Credential = &RouteCredentialCooldown{
				Until: row.Until, Failures: row.Failures, Reason: row.Reason, RequestID: row.RequestID,
				LastFailureAt: row.LastFailureAt, TriggerRouteID: row.RouteID,
			}
		}
		if st.Active() {
			out = append(out, st)
		}
	}
	return out, nil
}

func (a *AdminService) routeCooldownState(route storage.GatewayRoute) (*RouteCooldownState, error) {
	states, err := a.routeCooldownStates([]storage.GatewayRoute{route}, time.Now())
	if err != nil || len(states) == 0 {
		return &RouteCooldownState{RouteID: route.ID}, err
	}
	return &states[0], nil
}

// ReleaseRouteCooldown 绕过冷却直接探测该路由；任一测试成功即解除路由暂停与密钥冷却，
// 并解除测试成功的模型冷却。测试失败时保留冷却，错误原因在 Tests 中返回。
func (a *AdminService) ReleaseRouteCooldown(ctx context.Context, routeID uint, in ReleaseCooldownInput) (*ReleaseCooldownResult, error) {
	route, err := a.Routes.FindByID(routeID)
	if err != nil {
		return nil, err
	}
	if !route.Enabled {
		return nil, errors.New("route is disabled")
	}
	group, err := a.Groups.FindByID(route.GatewayGroupID)
	if err != nil {
		return nil, err
	}
	state, err := a.routeCooldownState(*route)
	if err != nil {
		return nil, err
	}
	models := a.releaseTestModels(group, *route, state, in.Model)
	if len(models) == 0 {
		return nil, errors.New("no model available to test on this route; specify model")
	}

	groupMapping := ParseModelMapping(group.ModelMappingJSON)
	started := time.Now()
	tests := make([]ModelTestResult, len(models))
	var wg sync.WaitGroup
	for i, model := range models {
		wg.Add(1)
		go func(i int, model string) {
			defer wg.Done()
			tests[i] = a.probeRouteModel(ctx, group, *route, model, groupMapping)
		}(i, model)
	}
	wg.Wait()

	res := &ReleaseCooldownResult{Tests: tests}
	for _, t := range tests {
		if !t.OK {
			continue
		}
		res.Released = true
		// started 之后真实流量新写入的失败不被本次测试抹掉（与 NoteModelSuccess 同口径）
		if err := a.Routes.NoteModelSuccess(route.ID, t.RequestedModel, started); err != nil {
			return nil, err
		}
		res.ClearedModels = append(res.ClearedModels, t.RequestedModel)
	}
	if res.Released {
		if state.PauseUntil != nil || hasRoutePauseResidue(route) {
			if err := a.Routes.ClearTempUnschedulable(route.ID); err != nil {
				return nil, err
			}
			res.ClearedPause = state.PauseUntil != nil
		}
		if state.Credential != nil {
			if target, err := a.resolveUpstreamTarget(route); err == nil {
				if err := a.Routes.NoteCredentialSuccess(credentialScope(target), started); err != nil {
					return nil, err
				}
				res.ClearedCredential = true
			}
		}
		if a.Log != nil {
			a.Log.Info("gateway route cooldown released by admin test", "route_id", route.ID,
				"cleared_pause", res.ClearedPause, "cleared_credential", res.ClearedCredential, "cleared_models", res.ClearedModels)
		}
	}
	if fresh, err := a.Routes.FindByID(route.ID); err == nil {
		route = fresh
	}
	if remaining, err := a.routeCooldownState(*route); err == nil {
		res.Remaining = remaining
	}
	return res, nil
}

func hasRoutePauseResidue(r *storage.GatewayRoute) bool {
	return strings.TrimSpace(r.TempUnschedulableReason) != "" || r.TempUnschedulableUntil != nil
}

// releaseTestModels 选择测试模型：显式指定 > 冷却中的模型 > 组内该路由可用的第一个模型。
func (a *AdminService) releaseTestModels(group *storage.GatewayGroup, route storage.GatewayRoute, state *RouteCooldownState, explicit string) []string {
	if m := strings.TrimSpace(explicit); m != "" {
		return []string{m}
	}
	var out []string
	if state != nil {
		for _, m := range state.Models {
			if len(out) >= releaseMaxModels {
				break
			}
			out = append(out, m.Model)
		}
	}
	if len(out) > 0 {
		return out
	}
	items := a.ParseModelsJSON(group.ModelsJSON)
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		for _, r := range filterRoutesForModel([]storage.GatewayRoute{route}, items, id) {
			if r.ID == route.ID {
				return []string{id}
			}
		}
	}
	return nil
}
