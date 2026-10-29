package kv

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisConfig Redis 连接配置。URL 优先（redis:// 或 rediss://），否则用 Addr/Password/DB。
type RedisConfig struct {
	URL       string
	Addr      string
	Password  string
	DB        int
	KeyPrefix string
}

// Enabled 是否配置了 Redis。
func (c RedisConfig) Enabled() bool {
	return strings.TrimSpace(c.URL) != "" || strings.TrimSpace(c.Addr) != ""
}

// Redis 基于 go-redis 的实现。所有 key 自动加前缀，便于和其它业务共用一个 Redis。
type Redis struct {
	client *redis.Client
	prefix string
}

// 释放锁必须「比对后删除」原子完成，否则可能删掉别的实例刚拿到的锁。
var delIfValueScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
end
return 0`)

// NewRedis 连接并 PING 一次；失败返回错误，由调用方决定回落内存。
func NewRedis(ctx context.Context, cfg RedisConfig) (*Redis, error) {
	var opts *redis.Options
	if u := strings.TrimSpace(cfg.URL); u != "" {
		parsed, err := redis.ParseURL(u)
		if err != nil {
			return nil, fmt.Errorf("parse redis url: %w", err)
		}
		opts = parsed
	} else {
		opts = &redis.Options{Addr: strings.TrimSpace(cfg.Addr), Password: cfg.Password, DB: cfg.DB}
	}
	// 缓存类访问宁可快速失败回落数据库，也不要拖慢请求
	opts.DialTimeout = 2 * time.Second
	opts.ReadTimeout = 500 * time.Millisecond
	opts.WriteTimeout = 500 * time.Millisecond
	client := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	prefix := cfg.KeyPrefix
	if prefix == "" {
		prefix = "flowrouter:"
	}
	return &Redis{client: client, prefix: prefix}, nil
}

func (r *Redis) k(key string) string { return r.prefix + key }

func wrap(err error) error {
	if err == nil || errors.Is(err, redis.Nil) {
		return nil
	}
	return fmt.Errorf("%w: %v", ErrUnavailable, err)
}

func (r *Redis) Get(ctx context.Context, key string) ([]byte, bool, error) {
	b, err := r.client.Get(ctx, r.k(key)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, wrap(err)
	}
	return b, true, nil
}

func (r *Redis) Set(ctx context.Context, key string, val []byte, ttl time.Duration) error {
	if ttl < 0 {
		ttl = 0
	}
	return wrap(r.client.Set(ctx, r.k(key), val, ttl).Err())
}

func (r *Redis) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	full := make([]string, len(keys))
	for i, k := range keys {
		full[i] = r.k(k)
	}
	return wrap(r.client.Del(ctx, full...).Err())
}

func (r *Redis) SetNX(ctx context.Context, key string, val []byte, ttl time.Duration) (bool, error) {
	if ttl < 0 {
		ttl = 0
	}
	ok, err := r.client.SetNX(ctx, r.k(key), val, ttl).Result()
	return ok, wrap(err)
}

func (r *Redis) DelIfValue(ctx context.Context, key string, val []byte) (bool, error) {
	n, err := delIfValueScript.Run(ctx, r.client, []string{r.k(key)}, val).Int()
	return n > 0, wrap(err)
}

func (r *Redis) Incr(ctx context.Context, key string) (int64, error) {
	n, err := r.client.Incr(ctx, r.k(key)).Result()
	return n, wrap(err)
}

// Ping 健康检查用。
func (r *Redis) Ping(ctx context.Context) error { return wrap(r.client.Ping(ctx).Err()) }

func (r *Redis) Backend() string { return "redis" }

func (r *Redis) Close() error { return r.client.Close() }
