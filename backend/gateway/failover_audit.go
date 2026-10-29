package gateway

type failoverAudit struct {
	RequestID    string
	GroupID      uint
	Model        string
	RouteID      uint
	Attempt      int
	Status       int
	HasContext   bool
	PinnedRoute  uint
	FailureClass string
}

func (rt *Runtime) logFailoverDecision(a *failoverAudit, action, reason string, nextRoute uint) {
	if rt.Log == nil {
		return
	}
	rt.Log.Info("gateway failover decision", "request_id", a.RequestID, "group_id", a.GroupID,
		"model", a.Model, "route_id", a.RouteID, "attempt", a.Attempt, "status", a.Status,
		"action", action, "reason", reason, "candidate_route_id", nextRoute,
		"has_upstream_context", a.HasContext, "pinned_route_id", a.PinnedRoute, "failure_class", a.FailureClass)
}

func failoverStopReason(retryEnabled, failoverEnabled, hasContext bool, done, maximum int) string {
	if hasContext {
		return "context_bound"
	}
	if !retryEnabled {
		return "retry_disabled"
	}
	if !failoverEnabled {
		return "failover_disabled"
	}
	if done >= maximum {
		return "failover_limit_reached"
	}
	return ""
}
