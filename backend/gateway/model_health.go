package gateway

import (
	"fmt"
	"math"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
)

func (rt *Runtime) filterModelCooldowns(c *gin.Context, routes []storage.GatewayRoute, model string, pinned bool) ([]storage.GatewayRoute, bool) {
	ids := make([]uint, 0, len(routes))
	for _, r := range routes {
		ids = append(ids, r.ID)
	}
	now := time.Now()
	cooldowns, err := rt.Routes.ModelCooldowns(ids, model, now)
	if err != nil {
		if rt.Log != nil {
			rt.Log.Error("read model cooldown failed", "err", err, "model", model)
		}
		return nil, false
	}
	if len(cooldowns) == 0 {
		return routes, true
	}
	out := make([]storage.GatewayRoute, 0, len(routes))
	var earliest time.Time
	skipped := []uint{}
	for _, route := range routes {
		if cd, ok := cooldowns[route.ID]; ok {
			skipped = append(skipped, route.ID)
			if earliest.IsZero() || cd.Until.Before(earliest) {
				earliest = cd.Until
			}
			continue
		}
		out = append(out, route)
	}
	if rt.Log != nil {
		rt.Log.Info("gateway model cooldown skip", "model", model, "route_ids", skipped, "pinned_context", pinned, "remaining_routes", len(out))
	}
	if len(out) == 0 && !earliest.IsZero() {
		seconds := int(math.Ceil(earliest.Sub(now).Seconds()))
		if seconds < 1 {
			seconds = 1
		}
		c.Header("Retry-After", fmt.Sprint(seconds))
	}
	return out, true
}

func (rt *Runtime) coolModel(routeID uint, model, reason, requestID string, seconds int) *time.Time {
	if seconds <= 0 || model == "" {
		return nil
	}
	row, err := rt.Routes.NoteModelFailure(routeID, model, reason, requestID, time.Duration(seconds)*time.Second, time.Now())
	if err != nil {
		if rt.Log != nil {
			rt.Log.Error("write model cooldown failed", "route_id", routeID, "model", model, "err", err)
		}
		return nil
	}
	if row == nil {
		return nil
	}
	if rt.Log != nil {
		rt.Log.Warn("gateway model cooldown started", "request_id", requestID, "route_id", routeID, "model", model, "failures", row.Failures, "cooldown_until", row.Until, "reason", reason)
	}
	return &row.Until
}
