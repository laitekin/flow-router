package storage

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GatewayModelCooldown isolates transient health failures to one route/model.
// State is durable across gateway restarts; no prompt or response content is stored.
type GatewayModelCooldown struct {
	RouteID       uint      `gorm:"primaryKey" json:"route_id"`
	Model         string    `gorm:"primaryKey;size:191" json:"model"`
	Failures      int       `json:"failures"`
	LastFailureAt time.Time `json:"last_failure_at"`
	Until         time.Time `gorm:"column:cooldown_until;index" json:"until"`
	Reason        string    `gorm:"size:1024" json:"reason"`
	RequestID     string    `gorm:"size:128" json:"request_id"`
}

func (r *GatewayRoutes) ModelCooldowns(routeIDs []uint, model string, now time.Time) (map[uint]GatewayModelCooldown, error) {
	out := map[uint]GatewayModelCooldown{}
	if len(routeIDs) == 0 || strings.TrimSpace(model) == "" {
		return out, nil
	}
	var rows []GatewayModelCooldown
	err := r.db.Where("route_id IN ? AND model = ? AND cooldown_until > ?", routeIDs, strings.TrimSpace(model), now).Find(&rows).Error
	for _, row := range rows {
		out[row.RouteID] = row
	}
	return out, err
}

func (r *GatewayRoutes) ActiveModelCooldowns(now time.Time) ([]GatewayModelCooldown, error) {
	var rows []GatewayModelCooldown
	err := r.db.Where("cooldown_until > ?", now).Order("cooldown_until DESC").Find(&rows).Error
	return rows, err
}

func (r *GatewayRoutes) NoteModelFailure(routeID uint, model, reason, requestID string, base time.Duration, now time.Time) (*GatewayModelCooldown, error) {
	model = strings.TrimSpace(model)
	if model == "" || base <= 0 {
		return nil, nil
	}
	r.modelCooldownMu.Lock()
	defer r.modelCooldownMu.Unlock()
	var result GatewayModelCooldown
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var prior GatewayModelCooldown
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("route_id = ? AND model = ?", routeID, model).First(&prior).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		failures := 1
		if err == nil && now.Sub(prior.LastFailureAt) <= 10*time.Minute {
			failures = prior.Failures + 1
		}
		if failures > 10 {
			failures = 10
		}
		duration := base
		limit := 5 * time.Minute
		if base > limit {
			limit = base
		}
		for i := 1; i < failures && duration < limit; i++ {
			duration *= 2
		}
		if duration > limit {
			duration = limit
		}
		runes := []rune(reason)
		if len(runes) > 1000 {
			reason = string(runes[:1000])
		}
		result = GatewayModelCooldown{RouteID: routeID, Model: model, Failures: failures, LastFailureAt: now, Until: now.Add(duration), Reason: reason, RequestID: requestID}
		return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&result).Error
	})
	return &result, err
}

// A successful older in-flight request must not clear a newer failure.
func (r *GatewayRoutes) NoteModelSuccess(routeID uint, model string, started time.Time) error {
	r.modelCooldownMu.Lock()
	defer r.modelCooldownMu.Unlock()
	return r.db.Where("route_id = ? AND model = ? AND last_failure_at <= ?", routeID, strings.TrimSpace(model), started).Delete(&GatewayModelCooldown{}).Error
}
