package gateway

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestBalancePolicyAdminDefaultsCreateOffAndPartialUpdate(t *testing.T) {
	f := newHealthFixture(t)
	g, err := f.svc.Admin.CreateGroup(CreateGroupInput{Name: "balance-defaults"})
	if err != nil || !g.BalanceFailoverEnabled || g.BalanceCooldownSeconds != 300 || g.BalanceCooldownMaxSeconds != 1800 {
		t.Fatalf("defaults=%+v err=%v", g, err)
	}
	off, zero := false, 0
	g, err = f.svc.Admin.CreateGroup(CreateGroupInput{Name: "balance-off", RetryEnabled: &off, FailoverEnabled: &off,
		FailoverMax: &zero, CooldownSeconds: &zero, BalanceFailoverEnabled: &off, BalanceCooldownSeconds: &zero, BalanceCooldownMaxSeconds: &zero})
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := f.svc.Groups.FindByID(g.ID)
	if g.RetryEnabled || stored.RetryEnabled || stored.FailoverEnabled || stored.FailoverMax != 0 || stored.CooldownSeconds != 0 || stored.BalanceFailoverEnabled || stored.BalanceCooldownSeconds != 0 || stored.BalanceCooldownMaxSeconds != 0 {
		t.Fatalf("false/zero overwritten: %+v", stored)
	}
	on, base, maximum := true, 12, 48
	g, err = f.svc.Admin.UpdateGroup(g.ID, UpdateGroupInput{BalanceFailoverEnabled: &on, BalanceCooldownSeconds: &base, BalanceCooldownMaxSeconds: &maximum})
	if err != nil || !g.BalanceFailoverEnabled || g.BalanceCooldownSeconds != 12 || g.BalanceCooldownMaxSeconds != 48 {
		t.Fatalf("update=%+v %v", g, err)
	}
	name := "balance-renamed"
	g, err = f.svc.Admin.UpdateGroup(g.ID, UpdateGroupInput{Name: &name})
	if err != nil || g.BalanceCooldownSeconds != 12 || g.BalanceCooldownMaxSeconds != 48 {
		t.Fatal("partial update reset policy")
	}
	for _, pair := range [][2]int{{-1, 100}, {10, 9}, {1, 86401}, {86401, 86401}} {
		_, err := f.svc.Admin.UpdateGroup(g.ID, UpdateGroupInput{BalanceCooldownSeconds: &pair[0], BalanceCooldownMaxSeconds: &pair[1]})
		if err == nil {
			t.Fatalf("accepted invalid policy: %v", pair)
		}
	}
	stored, _ = f.svc.Groups.FindByID(g.ID)
	if stored.BalanceCooldownSeconds != 12 || stored.BalanceCooldownMaxSeconds != 48 {
		t.Fatal("invalid update persisted")
	}
}

func TestBalancePolicySwitchOverridesGeneric4xxAndKeepsCooling(t *testing.T) {
	f := newHealthFixture(t)
	logs := captureHealthLogs(f)
	f.mode.Store(3)
	f.db.Model(f.group).Updates(map[string]any{"balance_failover_enabled": false, "balance_cooldown_seconds": 7, "balance_cooldown_max_seconds": 21, "failover_on4xx": true})
	w := f.call("gpt-sol", "", context.Background())
	rows, err := f.svc.Routes.ActiveCredentialCooldowns(time.Now())
	if w.Code != 403 || f.hitsA.Load() != 1 || f.hitsB.Load() != 0 || err != nil || len(rows) != 1 || rows[0].Until.Sub(rows[0].LastFailureAt) != 7*time.Second || !strings.Contains(logs.String(), "balance_failover_disabled") {
		t.Fatalf("off policy failed: %d %+v %s", w.Code, rows, logs.String())
	}
}

func TestBalancePolicyZeroCooldownDoesNotStopFailover(t *testing.T) {
	f := newHealthFixture(t)
	f.mode.Store(3)
	f.db.Model(f.group).Updates(map[string]any{"balance_cooldown_seconds": 0, "balance_cooldown_max_seconds": 0})
	for i := 0; i < 2; i++ {
		w := f.call("gpt-sol", "", context.Background())
		if w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") {
			t.Fatal("zero cooldown disabled failover")
		}
	}
	rows, _ := f.svc.Routes.ActiveCredentialCooldowns(time.Now())
	if len(rows) != 0 || f.hitsA.Load() != 2 || f.hitsB.Load() != 2 {
		t.Fatal("zero cooldown persisted or repeated same-route retries")
	}
	var count int64
	f.db.Model(&storage.GatewayUsageLog{}).Where("success = ?", false).Count(&count)
	if count != 2 {
		t.Fatal("unexpected attempt count")
	}
}
