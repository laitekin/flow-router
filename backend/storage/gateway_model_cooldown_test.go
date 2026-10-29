package storage

import (
	"testing"
	"time"
)

func TestModelCooldownIsolationBackoffPersistenceAndRecovery(t *testing.T) {
	db := openTestDB(t)
	repo := NewGatewayRoutes(db)
	now := time.Now().UTC().Truncate(time.Millisecond)
	first, err := repo.NoteModelFailure(1, "sol", "read reset", "req-1", time.Minute, now)
	if err != nil || first.Failures != 1 || first.Until.Sub(now) != time.Minute {
		t.Fatalf("first=%+v err=%v", first, err)
	}
	second, err := repo.NoteModelFailure(1, "sol", "read reset", "req-2", time.Minute, now.Add(time.Second))
	if err != nil || second.Failures != 2 || second.Until.Sub(now.Add(time.Second)) != 2*time.Minute {
		t.Fatalf("second=%+v err=%v", second, err)
	}
	// Re-opening the repository retains the circuit state.
	repo = NewGatewayRoutes(db)
	for _, tc := range []struct {
		route uint
		model string
		want  int
	}{{1, "sol", 1}, {1, "astra", 0}, {2, "sol", 0}} {
		got, err := repo.ModelCooldowns([]uint{tc.route}, tc.model, now.Add(2*time.Second))
		if err != nil || len(got) != tc.want {
			t.Fatalf("case=%+v got=%v err=%v", tc, got, err)
		}
	}
	if err := repo.NoteModelSuccess(1, "sol", now.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.ModelCooldowns([]uint{1}, "sol", now.Add(2*time.Second))
	if len(got) != 1 {
		t.Fatal("stale success erased newer failure")
	}
	for n := 3; n <= 9; n++ {
		r, err := repo.NoteModelFailure(1, "sol", "read reset", "req", time.Minute, now.Add(time.Duration(n)*time.Second))
		if err != nil || r.Until.Sub(r.LastFailureAt) > 5*time.Minute {
			t.Fatalf("backoff exceeds cap: %+v %v", r, err)
		}
	}
	got, _ = repo.ModelCooldowns([]uint{1}, "sol", now.Add(6*time.Minute))
	if len(got) != 0 {
		t.Fatal("expired circuit still excluded")
	}
	reset, err := repo.NoteModelFailure(1, "sol", "new failure", "req", time.Minute, now.Add(20*time.Minute))
	if err != nil || reset.Failures != 1 {
		t.Fatalf("old failure window not reset: %+v %v", reset, err)
	}
	if err := repo.NoteModelSuccess(1, "sol", now.Add(21*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&GatewayModelCooldown{}).Count(&count)
	if count != 0 {
		t.Fatal("fresh success did not reset circuit")
	}
}
