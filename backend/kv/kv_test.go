package kv

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"
)

// stores 内存实现总是测；设置 TEST_REDIS_URL 时再测 Redis，两者跑同一组断言。
func stores(t *testing.T) map[string]Store {
	t.Helper()
	out := map[string]Store{"memory": NewMemory()}
	if u := os.Getenv("TEST_REDIS_URL"); u != "" {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		r, err := NewRedis(context.Background(), RedisConfig{URL: u, KeyPrefix: "kvtest:" + hex.EncodeToString(b) + ":"})
		if err != nil {
			t.Fatalf("redis: %v", err)
		}
		out["redis"] = r
	}
	t.Cleanup(func() {
		for _, s := range out {
			_ = s.Close()
		}
	})
	return out
}

func TestStoreContract(t *testing.T) {
	ctx := context.Background()
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			if _, ok, err := s.Get(ctx, "missing"); ok || err != nil {
				t.Fatalf("missing key: ok=%v err=%v", ok, err)
			}
			if err := s.Set(ctx, "a", []byte("1"), time.Minute); err != nil {
				t.Fatalf("set: %v", err)
			}
			if v, ok, _ := s.Get(ctx, "a"); !ok || string(v) != "1" {
				t.Fatalf("get a = %q %v", v, ok)
			}
			if err := s.Set(ctx, "short", []byte("x"), 50*time.Millisecond); err != nil {
				t.Fatalf("set short: %v", err)
			}
			time.Sleep(120 * time.Millisecond)
			if _, ok, _ := s.Get(ctx, "short"); ok {
				t.Fatalf("expired key still readable")
			}

			if ok, _ := s.SetNX(ctx, "nx", []byte("first"), time.Minute); !ok {
				t.Fatalf("first SetNX should win")
			}
			if ok, _ := s.SetNX(ctx, "nx", []byte("second"), time.Minute); ok {
				t.Fatalf("second SetNX should lose")
			}
			if ok, _ := s.DelIfValue(ctx, "nx", []byte("second")); ok {
				t.Fatalf("DelIfValue must not delete someone else's value")
			}
			if ok, _ := s.DelIfValue(ctx, "nx", []byte("first")); !ok {
				t.Fatalf("DelIfValue should delete matching value")
			}

			for want := int64(1); want <= 3; want++ {
				if n, err := s.Incr(ctx, "ctr"); err != nil || n != want {
					t.Fatalf("incr = %d %v, want %d", n, err, want)
				}
			}
			if err := s.Del(ctx, "a", "ctr"); err != nil {
				t.Fatalf("del: %v", err)
			}
			if _, ok, _ := s.Get(ctx, "a"); ok {
				t.Fatalf("deleted key still readable")
			}
		})
	}
}

func TestLockAndThrottle(t *testing.T) {
	ctx := context.Background()
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			release, ok, err := Lock(ctx, s, "job", time.Minute)
			if err != nil || !ok {
				t.Fatalf("first lock: %v %v", ok, err)
			}
			if _, ok, _ := Lock(ctx, s, "job", time.Minute); ok {
				t.Fatalf("lock must be exclusive")
			}
			release()
			release2, ok, _ := Lock(ctx, s, "job", time.Minute)
			if !ok {
				t.Fatalf("lock should be free after release")
			}
			release2()

			if !Throttle(ctx, s, "touch:1", time.Minute) {
				t.Fatalf("first throttle call should pass")
			}
			if Throttle(ctx, s, "touch:1", time.Minute) {
				t.Fatalf("second call within window should be throttled")
			}
		})
	}
}

func TestOpenFallsBackToMemory(t *testing.T) {
	s := Open(context.Background(), RedisConfig{Addr: "127.0.0.1:1"}, nil)
	defer s.Close()
	if s.Backend() != "memory" {
		t.Fatalf("unreachable redis should fall back to memory, got %s", s.Backend())
	}
}
