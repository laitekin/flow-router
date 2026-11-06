package gateway

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestReleaseRouteCooldownTestsBeforeClearing(t *testing.T) {
	f := newHealthFixture(t)
	f.mode.Store(3)
	if w := f.call("gpt-sol", "", context.Background()); w.Code != 200 {
		t.Fatalf("failover failed: %d", w.Code)
	}
	states, err := f.svc.RouteCooldowns(f.group.ID)
	if err != nil || len(states) != 1 || states[0].RouteID != f.routeA || states[0].Credential == nil {
		t.Fatalf("credential cooldown not reported: %+v err=%v", states, err)
	}

	// 上游仍欠费：保留冷却，并返回具体原因
	res, err := f.svc.ReleaseRouteCooldown(context.Background(), f.routeA, ReleaseCooldownInput{Model: "gpt-sol"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Released || res.ClearedCredential || len(res.Tests) != 1 || res.Tests[0].StatusCode != 403 ||
		!strings.Contains(strings.ToLower(res.Tests[0].Error), "insufficient") {
		t.Fatalf("failed test must keep cooldown: %+v", res)
	}
	if rows, _ := f.svc.Routes.ActiveCredentialCooldowns(time.Now()); len(rows) != 1 {
		t.Fatal("cooldown cleared despite failed test")
	}
	if res.Remaining == nil || res.Remaining.Credential == nil {
		t.Fatal("remaining state missing")
	}

	// 已充值：测试成功即解除，路由恢复调度（未指定模型时自动选组内模型）
	f.mode.Store(0)
	res, err = f.svc.ReleaseRouteCooldown(context.Background(), f.routeA, ReleaseCooldownInput{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Released || !res.ClearedCredential || len(res.Tests) != 1 || !res.Tests[0].OK {
		t.Fatalf("release failed: %+v", res)
	}
	if rows, _ := f.svc.Routes.ActiveCredentialCooldowns(time.Now()); len(rows) != 0 {
		t.Fatal("cooldown not cleared")
	}
	if res.Remaining == nil || res.Remaining.Active() {
		t.Fatalf("remaining should be empty: %+v", res.Remaining)
	}
	hitsA := f.hitsA.Load()
	if w := f.call("gpt-sol", "", context.Background()); w.Code != 200 || f.hitsA.Load() != hitsA+1 {
		t.Fatal("released route not scheduled again")
	}
}

func TestReleaseRouteCooldownClearsTestedModelCooldown(t *testing.T) {
	f := newHealthFixture(t)
	if _, err := f.svc.Routes.NoteModelFailure(f.routeA, "gpt-sol", "upstream 503", "req-1", time.Minute, time.Now()); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.ReleaseRouteCooldown(context.Background(), f.routeA, ReleaseCooldownInput{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Released || len(res.ClearedModels) != 1 || res.ClearedModels[0] != "gpt-sol" || res.Remaining.Active() {
		t.Fatalf("model cooldown not released: %+v", res)
	}
}
