// Package kv 提供可替换的键值存储：配置了 Redis 时用 Redis（多实例共享），否则用进程内内存。
//
// 只放「丢了也能重建」的数据：缓存、节流标记、分布式锁、失效版本号。
// 计费、额度、配置等需要持久化的数据仍以数据库为准，kv 故障时调用方一律回落到数据库。
package kv

import (
	"context"
	"errors"
	"time"
)

// ErrUnavailable kv 后端不可用（连接失败等）。调用方应把它当作缓存未命中处理。
var ErrUnavailable = errors.New("kv unavailable")

// Store 最小键值接口。key 由调用方拼好，实现负责加统一前缀。
type Store interface {
	// Get 未命中返回 (nil, false, nil)
	Get(ctx context.Context, key string) ([]byte, bool, error)
	// Set ttl <= 0 表示不过期
	Set(ctx context.Context, key string, val []byte, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
	// SetNX 仅当 key 不存在时写入，返回是否写入成功（节流 / 加锁用）
	SetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error)
	// DelIfValue 仅当当前值等于 val 时删除（释放自己持有的锁，不误删别人的）
	DelIfValue(ctx context.Context, key string, val []byte) (bool, error)
	// Incr 自增并返回新值；key 不存在时从 0 开始
	Incr(ctx context.Context, key string) (int64, error)
	// Backend "memory" | "redis"
	Backend() string
	Close() error
}
