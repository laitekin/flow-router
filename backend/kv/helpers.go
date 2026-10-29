package kv

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"time"
)

// Open 按配置选择后端：配置了 Redis 且连得上就用 Redis；没配置或连不上则回落内存并告警。
// Redis 只承载可重建数据，所以连不上不阻止启动。
func Open(ctx context.Context, cfg RedisConfig, log *slog.Logger) Store {
	if !cfg.Enabled() {
		return NewMemory()
	}
	r, err := NewRedis(ctx, cfg)
	if err != nil {
		if log != nil {
			log.Warn("redis unavailable, falling back to in-memory kv (caches/locks are per-instance)", "err", err)
		}
		return NewMemory()
	}
	return r
}

// Lock 尝试获取一把带过期时间的锁。拿到返回释放函数；被别人持有返回 (nil, false, nil)。
// ttl 到期自动释放，防止持锁实例崩溃后永远锁死。
func Lock(ctx context.Context, s Store, key string, ttl time.Duration) (func(), bool, error) {
	token := make([]byte, 16)
	_, _ = rand.Read(token)
	val := []byte(hex.EncodeToString(token))
	ok, err := s.SetNX(ctx, key, val, ttl)
	if err != nil || !ok {
		return nil, false, err
	}
	return func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = s.DelIfValue(releaseCtx, key, val)
	}, true, nil
}

// Throttle 在 window 内对同一 key 只放行一次（多实例共享时全局只放行一次）。
// kv 出错时放行，保证调用方的原逻辑不受影响。
func Throttle(ctx context.Context, s Store, key string, window time.Duration) bool {
	ok, err := s.SetNX(ctx, key, []byte("1"), window)
	if err != nil {
		return true
	}
	return ok
}
