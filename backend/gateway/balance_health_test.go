package gateway

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestBalanceClassifier(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   bool
	}{
		{403, `{"error":{"message":"insufficient balance"}}`, true},
		{403, `{"error":{"message":"Insufficient account balance"}}`, true},
		{402, `{"error":{"message":"余额不足，请充值"}}`, true},
		{429, `{"error":{"code":"insufficient_quota"}}`, true},
		{400, `{"error":{"type":"billing_hard_limit_reached"}}`, true},
		{403, `{"message":"credit balance is too low"}`, true},
		{403, `{"error":{"message":"permission denied"}}`, false},
		{401, `{"error":{"message":"invalid api key"}}`, false},
		{400, `{"error":{"message":"context length exceeded"}}`, false},
		{429, `{"error":{"code":"rate_limit_exceeded","message":"requests per minute quota exceeded"}}`, false},
		{200, `{"message":"insufficient balance"}`, false},
		{403, `<html>insufficient balance</html>`, false},
		{403, `{"input":"insufficient balance","error":{"message":"bad request"}}`, false},
	} {
		if got := isBalanceExhausted(tc.status, []byte(tc.body)); got != tc.want {
			t.Errorf("status=%d body=%s got=%v", tc.status, tc.body, got)
		}
	}
}

func captureHealthLogs(f *healthFixture) *bytes.Buffer {
	b := &bytes.Buffer{}
	f.svc.Log = slog.New(slog.NewJSONHandler(b, nil))
	return b
}

func TestBalanceFailoverSharesCooldownAcrossModelsAndGroups(t *testing.T) {
	f := newHealthFixture(t)
	logs := captureHealthLogs(f)
	f.mode.Store(3)
	// Even an explicit same-route retry policy must not hammer an insolvent key.
	f.db.Model(f.group).Update("retry_count", 3)
	w := f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") || f.hitsA.Load() != 1 || f.hitsB.Load() != 1 {
		t.Fatalf("balance failover failed: %d %s", w.Code, w.Body.String())
	}
	rows, err := f.svc.Routes.ActiveCredentialCooldowns(time.Now())
	if err != nil || len(rows) != 1 || rows[0].Until.Sub(rows[0].LastFailureAt) != 5*time.Minute {
		t.Fatalf("cooldown=%+v err=%v", rows, err)
	}
	var usage []storage.GatewayUsageLog
	f.db.Order("id").Find(&usage)
	if len(usage) != 2 || usage[0].CooldownUntil == nil || usage[1].AttemptKind != "failover" {
		t.Fatal("balance attempt audit missing")
	}
	w = f.call("gpt-astra", "", context.Background())
	if w.Code != 200 || f.hitsA.Load() != 1 || f.hitsB.Load() != 2 {
		t.Fatal("other model reused exhausted credential")
	}
	group2 := *f.group
	group2.ID = 0
	group2.Name = "other-group"
	if err := f.svc.Groups.Create(&group2); err != nil {
		t.Fatal(err)
	}
	routes, _ := f.svc.Routes.ListByGroupID(f.group.ID)
	for i := range routes {
		routes[i].ID = 0
		routes[i].GatewayGroupID = group2.ID
	}
	if err := f.svc.Routes.SaveForGroup(group2.ID, routes); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Model(&storage.GatewayKey{}).Where("name = ?", "health-key").Update("group_id", group2.ID).Error; err != nil {
		t.Fatal(err)
	}
	w = f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || f.hitsA.Load() != 1 || f.hitsB.Load() != 3 {
		t.Fatal("other group reused exhausted credential")
	}
	if !strings.Contains(logs.String(), `"action":"failover"`) || !strings.Contains(logs.String(), `"reason":"credential_cooling_down"`) {
		t.Fatal(logs.String())
	}
}

func TestBalanceBoundContextStopsAndLogsReason(t *testing.T) {
	f := newHealthFixture(t)
	logs := captureHealthLogs(f)
	f.call("gpt-sol", "", context.Background()) // binds resp_a_1
	f.mode.Store(3)
	w := f.call("gpt-sol", "resp_a_1", context.Background())
	if w.Code != 403 || f.hitsB.Load() != 0 || !strings.Contains(logs.String(), `"reason":"context_bound"`) {
		t.Fatalf("unsafe failover or missing reason: %s", logs.String())
	}
	w = f.call("gpt-sol", "resp_a_1", context.Background())
	if w.Code != 503 || w.Header().Get("Retry-After") == "" || f.hitsA.Load() != 2 || !strings.Contains(logs.String(), `"reason":"context_bound_credential_cooling_down"`) {
		t.Fatal("bound cooldown missing")
	}
}

func TestBalanceDoesNotRetryDuplicateCredential(t *testing.T) {
	f := newHealthFixture(t)
	logs := captureHealthLogs(f)
	a, _ := f.svc.Routes.FindByID(f.routeA)
	b, _ := f.svc.Routes.FindByID(f.routeB)
	pa, _ := f.svc.Providers.FindByID(a.GatewayProviderID)
	f.db.Model(&storage.GatewayProvider{}).Where("id = ?", b.GatewayProviderID).Update("base_url", pa.BaseURL)
	f.mode.Store(3)
	w := f.call("gpt-sol", "", context.Background())
	if w.Code != 403 || f.hitsA.Load() != 1 || !strings.Contains(logs.String(), `"reason":"no_eligible_backup"`) {
		t.Fatal("same credential retried via another route")
	}
	w = f.call("gpt-sol", "", context.Background())
	if w.Code != 503 || w.Header().Get("Retry-After") == "" || f.hitsA.Load() != 1 {
		t.Fatal("all-cooled request was not rejected")
	}
}

func TestNormal403IsNotBalanceFailure(t *testing.T) {
	f := newHealthFixture(t)
	logs := captureHealthLogs(f)
	f.mode.Store(4)
	w := f.call("gpt-sol", "", context.Background())
	rows, err := f.svc.Routes.ActiveCredentialCooldowns(time.Now())
	if w.Code != 403 || f.hitsB.Load() != 0 || err != nil || len(rows) != 0 || !strings.Contains(logs.String(), `"reason":"non_retryable_http_status"`) {
		t.Fatal("generic 403 became billing failure")
	}
}

func TestFailoverDecisionReasons(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*healthFixture)
		want   string
	}{
		{"retry-off", func(f *healthFixture) { f.db.Model(f.group).Update("retry_enabled", false) }, "retry_disabled"},
		{"failover-off", func(f *healthFixture) { f.db.Model(f.group).Update("failover_enabled", false) }, "failover_disabled"},
		{"limit", func(f *healthFixture) { f.db.Model(f.group).Update("failover_max", 0) }, "failover_limit_reached"},
		{"no-backup", func(f *healthFixture) {
			f.db.Model(&storage.GatewayRoute{}).Where("id = ?", f.routeB).Update("enabled", false)
		}, "no_eligible_backup"},
		{"committed", func(f *healthFixture) { f.mode.Store(2) }, "stream_already_committed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHealthFixture(t)
			logs := captureHealthLogs(f)
			f.mode.Store(3)
			tc.change(f)
			f.call("gpt-sol", "", context.Background())
			if !strings.Contains(logs.String(), `"reason":"`+tc.want+`"`) {
				t.Fatalf("missing %s: %s", tc.want, logs.String())
			}
		})
	}
}
