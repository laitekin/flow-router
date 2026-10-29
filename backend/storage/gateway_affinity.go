package storage

import (
	"fmt"
	"time"

	"gorm.io/gorm/clause"
)

// GatewayContextAffinity stores hashes only, never response content or tokens.
type GatewayContextAffinity struct {
	KeyID       uint   `gorm:"primaryKey"`
	GroupID     uint   `gorm:"primaryKey"`
	Fingerprint string `gorm:"primaryKey;size:64"`
	RouteID     uint
	ExpiresAt   time.Time `gorm:"index"`
}

func (r *GatewayRoutes) ResolveContextRoute(keyID, groupID uint, refs []string) (uint, error) {
	if len(refs) == 0 {
		return 0, nil
	}
	var rows []GatewayContextAffinity
	err := r.db.Where("key_id = ? AND group_id = ? AND fingerprint IN ? AND expires_at > ?", keyID, groupID, refs, time.Now()).Find(&rows).Error
	if err != nil {
		return 0, err
	}
	var route uint
	for _, row := range rows {
		if route != 0 && route != row.RouteID {
			return 0, fmt.Errorf("context contains references from different upstream routes; start a new conversation")
		}
		route = row.RouteID
	}
	return route, nil
}

func (r *GatewayRoutes) RememberContextRoute(keyID, groupID, routeID uint, refs []string) error {
	if len(refs) == 0 {
		return nil
	}
	now := time.Now()
	if err := r.db.Where("expires_at < ?", now).Delete(&GatewayContextAffinity{}).Error; err != nil {
		return err
	}
	rows := make([]GatewayContextAffinity, 0, len(refs))
	for _, ref := range refs {
		rows = append(rows, GatewayContextAffinity{KeyID: keyID, GroupID: groupID, RouteID: routeID, Fingerprint: ref, ExpiresAt: now.Add(7 * 24 * time.Hour)})
	}
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
}
