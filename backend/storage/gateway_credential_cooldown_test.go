package storage

import (
	"testing"
	"time"
)

func TestCredentialCooldownPersistenceBackoffAndStaleSuccess(t *testing.T) {
	db := openTestDB(t)
	repo := NewGatewayRoutes(db)
	now := time.Now().UTC().Truncate(time.Millisecond)
	for i, minutes := range []int{5, 10, 20, 30, 30} {
		ts := now.Add(time.Duration(i) * time.Minute)
		row, err := repo.NoteCredentialFailure("digest-a", 1, 2, "req", 5*time.Minute, 30*time.Minute, ts)
		if err != nil || row.Until.Sub(ts) != time.Duration(minutes)*time.Minute {
			t.Fatalf("row=%+v err=%v", row, err)
		}
	}
	repo = NewGatewayRoutes(db)
	repo.NoteCredentialSuccess("digest-a", now)
	rows, err := repo.CredentialCooldowns([]string{"digest-a", "digest-b"}, now.Add(5*time.Minute))
	if err != nil || len(rows) != 1 {
		t.Fatal("state lost or stale success cleared failure")
	}
	rows, _ = repo.CredentialCooldowns([]string{"digest-a"}, now.Add(35*time.Minute))
	if len(rows) != 0 {
		t.Fatal("expired cooldown still blocks")
	}
	repo.NoteCredentialSuccess("digest-a", now.Add(36*time.Minute))
	row, err := repo.NoteCredentialFailure("digest-a", 1, 2, "new", 5*time.Minute, 30*time.Minute, now.Add(37*time.Minute))
	if err != nil || row.Failures != 1 {
		t.Fatal("successful recovery did not reset backoff")
	}
}
