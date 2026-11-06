package balancealert

import (
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/notify"
	"github.com/bejix/upstream-ops/backend/storage"
)

var testPolicy = notify.BalanceAlertPolicy{
	RunwayWarnHours: 24, RunwayCriticalHours: 3,
	WarnRepeat: 12 * time.Hour, CriticalRepeat: 2 * time.Hour, ExhaustedRepeat: 30 * time.Minute,
	AutoReleaseOnRecharge: true, UrgentScanInterval: 5 * time.Minute,
}

func snaps(now time.Time, pts ...[2]float64) []storage.BalanceSnapshot {
	out := make([]storage.BalanceSnapshot, 0, len(pts))
	for _, p := range pts {
		out = append(out, storage.BalanceSnapshot{Balance: p[1], SampledAt: now.Add(-time.Duration(p[0] * float64(time.Minute)))})
	}
	return out
}

func TestBurnRateIgnoresRechargeAndTakesFasterWindow(t *testing.T) {
	now := time.Now()
	// 24h 内匀速 1/小时，中途充值 +100 不应抵扣消耗
	rate, ok := burnRateFromSnapshots(snaps(now, [2]float64{1440, 200}, [2]float64{720, 188}, [2]float64{719, 288}, [2]float64{0, 276}), now)
	if !ok || rate < 0.99 || rate > 1.01 {
		t.Fatalf("24h rate = %v ok=%v", rate, ok)
	}
	// 最近 1 小时突然 10/小时：取较大者
	rate, ok = burnRateFromSnapshots(snaps(now, [2]float64{1440, 300}, [2]float64{60, 290}, [2]float64{0, 280}), now)
	if !ok || rate < 9.9 {
		t.Fatalf("burst rate = %v", rate)
	}
	// 跨度太短不估算
	if _, ok := burnRateFromSnapshots(snaps(now, [2]float64{10, 100}, [2]float64{0, 90}), now); ok {
		t.Fatal("span < 20m must not estimate")
	}
}

func TestBurnRateFromCosts(t *testing.T) {
	if r := burnRateFromCosts(0, 48, 48*time.Hour); r != 2 {
		t.Fatalf("got %v", r)
	}
	// 新渠道只跑了 6 小时：按 6 小时折算而不是 24
	if r := burnRateFromCosts(0, 12, 6*time.Hour); r != 2 {
		t.Fatalf("young provider got %v", r)
	}
	if r := burnRateFromCosts(5, 24, 48*time.Hour); r != 5 {
		t.Fatalf("burst got %v", r)
	}
}

func TestRechargeDetected(t *testing.T) {
	for _, tc := range []struct {
		prev, cur float64
		want      bool
	}{{10, 60, true}, {0.2, 1, true}, {100, 100.3, false}, {100, 104, false}, {100, 106, true}, {50, 40, false}} {
		if got := rechargeDetected(tc.prev, tc.cur); got != tc.want {
			t.Errorf("%v→%v got %v", tc.prev, tc.cur, got)
		}
	}
}

func TestClassify(t *testing.T) {
	if a := classify(testPolicy, 0, 0, 1, true, true); a.Level != storage.BalanceLevelExhausted {
		t.Fatal("zero balance must be exhausted")
	}
	if a := classify(testPolicy, 2, 0, 1, true, true); a.Level != storage.BalanceLevelCritical || *a.RunwayHours != 2 {
		t.Fatalf("2h runway: %+v", a)
	}
	if a := classify(testPolicy, 10, 0, 1, true, true); a.Level != storage.BalanceLevelWarn {
		t.Fatalf("10h runway: %+v", a)
	}
	if a := classify(testPolicy, 100, 0, 1, true, true); a.Level != storage.BalanceLevelOK {
		t.Fatalf("100h runway: %+v", a)
	}
	// 未在用：只看手填阈值
	if a := classify(testPolicy, 2, 0, 1, true, false); a.Level != storage.BalanceLevelOK {
		t.Fatalf("not in use: %+v", a)
	}
	if a := classify(testPolicy, 2, 5, 0, false, false); a.Level != storage.BalanceLevelWarn {
		t.Fatalf("manual threshold: %+v", a)
	}
}

func TestDecide(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	ok := &storage.BalanceAlertState{Level: storage.BalanceLevelOK}
	if d := decide(testPolicy, ok, storage.BalanceLevelWarn, now); !d.Send || d.Event != storage.EventBalanceLow {
		t.Fatal("escalation must send")
	}
	warn := &storage.BalanceAlertState{Level: storage.BalanceLevelWarn, LastSentLevel: storage.BalanceLevelWarn, LastSentAt: ago(time.Hour)}
	if d := decide(testPolicy, warn, storage.BalanceLevelWarn, now); d.Send {
		t.Fatal("same level within repeat must not send")
	}
	warn.LastSentAt = ago(13 * time.Hour)
	if d := decide(testPolicy, warn, storage.BalanceLevelWarn, now); !d.Send {
		t.Fatal("same level after repeat must send")
	}
	if d := decide(testPolicy, warn, storage.BalanceLevelCritical, now); !d.Send || d.Event != storage.EventBalanceCritical {
		t.Fatal("warn→critical must send")
	}
	crit := &storage.BalanceAlertState{Level: storage.BalanceLevelCritical, LastSentLevel: storage.BalanceLevelCritical, LastSentAt: ago(time.Minute)}
	if d := decide(testPolicy, crit, storage.BalanceLevelWarn, now); d.Send {
		t.Fatal("de-escalation must be silent")
	}
	if d := decide(testPolicy, crit, storage.BalanceLevelOK, now); !d.Send || !d.Recovered {
		t.Fatal("back to ok must send recovery")
	}
	silent := &storage.BalanceAlertState{Level: storage.BalanceLevelWarn}
	if d := decide(testPolicy, silent, storage.BalanceLevelOK, now); d.Send {
		t.Fatal("never notified → no recovery message")
	}
	snoozed := &storage.BalanceAlertState{Level: storage.BalanceLevelOK, SnoozeUntil: func() *time.Time { t := now.Add(time.Hour); return &t }()}
	if d := decide(testPolicy, snoozed, storage.BalanceLevelExhausted, now); d.Send {
		t.Fatal("snoozed must not send")
	}
}
