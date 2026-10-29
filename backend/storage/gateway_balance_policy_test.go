package storage

import (
	"testing"
	"time"
)

func TestBalancePolicyMigrationAndFalseSurvivesRestart(t *testing.T) {
	db := openTestDB(t)
	for _, field := range []string{"BalanceFailoverEnabled", "BalanceCooldownSeconds", "BalanceCooldownMaxSeconds"} {
		if err := db.Migrator().DropColumn(&GatewayGroup{}, field); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec("INSERT INTO gateway_groups(name) VALUES (?)", "legacy-group").Error; err != nil {
		t.Fatal(err)
	}
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	var g GatewayGroup
	if err := db.Where("name = ?", "legacy-group").First(&g).Error; err != nil {
		t.Fatal(err)
	}
	if !g.BalanceFailoverEnabled || g.BalanceCooldownSeconds != 300 || g.BalanceCooldownMaxSeconds != 1800 {
		t.Fatalf("legacy defaults=%+v", g)
	}
	db.Model(&g).Updates(map[string]any{"balance_failover_enabled": false, "balance_cooldown_seconds": 0, "balance_cooldown_max_seconds": 0})
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	db.First(&g, g.ID)
	if g.BalanceFailoverEnabled || g.BalanceCooldownSeconds != 0 || g.BalanceCooldownMaxSeconds != 0 {
		t.Fatal("restart reset disabled policy")
	}
}

func TestCredentialCustomBackoffZeroAndSharedState(t *testing.T) {
	repo := NewGatewayRoutes(openTestDB(t))
	now := time.Now().UTC()
	for i, want := range []time.Duration{7, 14, 21, 21} {
		ts := now.Add(time.Duration(i) * time.Second)
		row, err := repo.NoteCredentialFailure("custom", 1, 2, "req", 7*time.Second, 21*time.Second, ts)
		if err != nil || row.Until.Sub(ts) != want*time.Second {
			t.Fatalf("row=%+v err=%v", row, err)
		}
	}
	prior, _ := repo.CredentialCooldowns([]string{"custom"}, now)
	row, err := repo.NoteCredentialFailure("custom", 3, 2, "other-group", time.Second, time.Second, now.Add(4*time.Second))
	if err != nil || row.Until.Before(prior["custom"].Until) {
		t.Fatal("another group shortened active cooldown")
	}
	row, err = repo.NoteCredentialFailure("custom", 3, 2, "disabled", 0, 0, now.Add(5*time.Second))
	if err != nil || row != nil {
		t.Fatal("zero policy created a cooldown")
	}
	rows, _ := repo.CredentialCooldowns([]string{"custom"}, now.Add(5*time.Second))
	if len(rows) != 1 {
		t.Fatal("zero policy erased shared state")
	}
}
