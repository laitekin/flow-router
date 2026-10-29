package scheduler

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/config"
	"github.com/bejix/upstream-ops/backend/kv"
	"github.com/bejix/upstream-ops/backend/monitor"
	"github.com/bejix/upstream-ops/backend/storage"
	"gorm.io/gorm"
)

type fakeGatewayResort struct {
	called int
}

func (f *fakeGatewayResort) ResortRoutesOnRateScan(_ context.Context) {
	f.called++
}

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, cleanup, err := storage.OpenTestDB(t.TempDir())
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(cleanup)
	return db
}

func TestRunRetentionDeletesAnnouncements(t *testing.T) {
	db := openTestDB(t)
	announcements := storage.NewUpstreamAnnouncements(db)
	notifies := storage.NewNotifications(db)
	monLogs := storage.NewMonitorLogs(db)
	rates := storage.NewRates(db)

	oldTime := time.Now().AddDate(0, 0, -10)
	if _, err := announcements.Sync(1, []storage.UpstreamAnnouncement{{
		ChannelID:   1,
		SourceKey:   "old",
		Content:     "old",
		FirstSeenAt: oldTime,
	}}); err != nil {
		t.Fatalf("sync announcement: %v", err)
	}

	s := New(
		config.SchedulerConfig{
			Retention: config.RetentionConfig{
				AnnouncementsDays: 1,
			},
		},
		&monitor.Service{},
		monLogs,
		rates,
		notifies,
		announcements,
		nil,
		nil,
		nil,
		config.ProxyConfig{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)

	s.runRetention()

	list, total, err := announcements.ListPage(1, 10)
	if err != nil {
		t.Fatalf("list announcements: %v", err)
	}
	if total != 0 || len(list) != 0 {
		t.Fatalf("announcements not cleaned: total=%d list=%#v", total, list)
	}
}

func TestRunRatesTriggersGatewayResort(t *testing.T) {
	gatewayResort := &fakeGatewayResort{}
	s := New(
		config.SchedulerConfig{},
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		nil,
		gatewayResort,
		config.ProxyConfig{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)

	s.runRates()

	if gatewayResort.called != 1 {
		t.Fatalf("gateway resort calls = %d, want 1", gatewayResort.called)
	}
}

func TestLockedJobRunsOnceAcrossInstances(t *testing.T) {
	store := kv.NewMemory()
	t.Cleanup(func() { _ = store.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := &Scheduler{log: log, kv: store}
	b := &Scheduler{log: log, kv: store}

	var runs int32
	started := make(chan struct{})
	finish := make(chan struct{})
	slow := func() {
		atomic.AddInt32(&runs, 1)
		close(started)
		<-finish
	}
	done := make(chan struct{})
	go func() { a.locked("job", slow)(); close(done) }()
	<-started
	// 另一个实例同一时刻触发：锁被占，跳过
	b.locked("job", func() { atomic.AddInt32(&runs, 1) })()
	close(finish)
	<-done
	if got := atomic.LoadInt32(&runs); got != 1 {
		t.Fatalf("job ran %d times while locked, want 1", got)
	}
	// 释放后下一轮可以正常执行
	b.locked("job", func() { atomic.AddInt32(&runs, 1) })()
	if got := atomic.LoadInt32(&runs); got != 2 {
		t.Fatalf("job should run after lock release, runs=%d", got)
	}
}
