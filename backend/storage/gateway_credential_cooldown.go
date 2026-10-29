package storage

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// A digest of endpoint + credential shares billing health across routes/models.
// Neither credentials nor request bodies are stored or returned by the API.
type GatewayCredentialCooldown struct {
	ScopeHash     string    `gorm:"primaryKey;size:64" json:"-"`
	RouteID       uint      `json:"route_id"`
	ProviderID    uint      `json:"provider_id"`
	Failures      int       `json:"failures"`
	LastFailureAt time.Time `json:"last_failure_at"`
	Until         time.Time `gorm:"column:cooldown_until;index" json:"until"`
	Reason        string    `gorm:"size:64" json:"reason"`
	RequestID     string    `gorm:"size:128" json:"request_id"`
}

func (r *GatewayRoutes) CredentialCooldowns(scopes []string, now time.Time) (map[string]GatewayCredentialCooldown, error) {
	out := map[string]GatewayCredentialCooldown{}
	if len(scopes) == 0 {
		return out, nil
	}
	var rows []GatewayCredentialCooldown
	err := r.db.Where("scope_hash IN ? AND cooldown_until > ?", scopes, now).Find(&rows).Error
	for _, row := range rows {
		out[row.ScopeHash] = row
	}
	return out, err
}

func (r *GatewayRoutes) ActiveCredentialCooldowns(now time.Time) ([]GatewayCredentialCooldown, error) {
	var rows []GatewayCredentialCooldown
	err := r.db.Where("cooldown_until > ?", now).Order("cooldown_until DESC").Find(&rows).Error
	return rows, err
}

func (r *GatewayRoutes) NoteCredentialFailure(scope string, routeID, providerID uint, requestID string, base, maximum time.Duration, now time.Time) (*GatewayCredentialCooldown, error) {
	if scope == "" || base <= 0 {
		return nil, nil
	}
	if maximum < base || maximum > 24*time.Hour {
		return nil, errors.New("invalid credential cooldown range")
	}
	r.modelCooldownMu.Lock()
	defer r.modelCooldownMu.Unlock()
	var result GatewayCredentialCooldown
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var prior GatewayCredentialCooldown
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("scope_hash = ?", scope).First(&prior).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		failures := 1
		if err == nil && now.Sub(prior.LastFailureAt) <= time.Hour {
			failures = prior.Failures + 1
		}
		if failures > 20 {
			failures = 20
		}
		duration := base
		for i := 1; i < failures && duration < maximum; i++ {
			duration *= 2
		}
		if duration > maximum {
			duration = maximum
		}
		until := now.Add(duration)
		// Another group or an older in-flight request must not shorten a
		// credential-wide cooldown which is already in force.
		if prior.Until.After(until) {
			until = prior.Until
		}
		result = GatewayCredentialCooldown{ScopeHash: scope, RouteID: routeID, ProviderID: providerID,
			Failures: failures, LastFailureAt: now, Until: until, Reason: "balance_exhausted", RequestID: requestID}
		return tx.Clauses(clause.OnConflict{UpdateAll: true}).Create(&result).Error
	})
	return &result, err
}

func (r *GatewayRoutes) NoteCredentialSuccess(scope string, started time.Time) error {
	if scope == "" {
		return nil
	}
	r.modelCooldownMu.Lock()
	defer r.modelCooldownMu.Unlock()
	return r.db.Where("scope_hash = ? AND last_failure_at <= ?", scope, started).Delete(&GatewayCredentialCooldown{}).Error
}
