// 数据面：基于 kv（Redis / 内存）的鉴权缓存、密钥使用时间节流、模型列表缓存。
package gateway

import (
	"bytes"
	"context"
	"encoding/gob"
	"fmt"
	"strconv"
	"time"

	"github.com/bejix/upstream-ops/backend/kv"
	"github.com/bejix/upstream-ops/backend/storage"
)

const (
	// authCacheTTL 鉴权快照缓存时间。管理端改密钥 / 分组会立即让缓存失效（版本号），
	// TTL 只是兜底，防止版本号丢失时脏数据长期存在。
	authCacheTTL = 30 * time.Second
	// touchKeyWindow last_used_at 最多每分钟落库一次；原先每个请求都写一次数据库。
	touchKeyWindow = time.Minute

	kvKeyAuthVersion = "gw:authver"
)

type authSnapshot struct {
	Key   storage.GatewayKey
	Group storage.GatewayGroup
}

// SetKV 注入 kv 后端（main 组装时调用）。数据库写入后的失效回调由 main 通过
// storage.OnGatewayAuthChange(db, svc.InvalidateAuthCache) 挂上。
func (s *Service) SetKV(store kv.Store) {
	if store != nil {
		s.KV = store
	}
}

// InvalidateAuthCache 版本号 +1，所有实例上的旧鉴权缓存立即作废。
func (s *Service) InvalidateAuthCache() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.KV.Incr(ctx, kvKeyAuthVersion); err != nil && s.Log != nil {
		s.Log.Warn("invalidate gateway auth cache failed", "err", err)
	}
}

func (rt *Runtime) authCacheKey(ctx context.Context, hash string) (string, bool) {
	raw, _, err := rt.KV.Get(ctx, kvKeyAuthVersion)
	if err != nil {
		return "", false
	}
	ver, _ := strconv.ParseInt(string(raw), 10, 64)
	return fmt.Sprintf("gw:auth:%d:%s", ver, hash), true
}

// lookupAuth 按密钥哈希取密钥与所属分组：先查缓存，未命中查库。
//
// 只缓存不限额（Quota == 0）的密钥：有额度的密钥要拿最新的 quota_used 判断是否超额，
// 每次都读库，行为与原来完全一致。kv 出任何错误都直接走数据库。
func (rt *Runtime) lookupAuth(ctx context.Context, hash string) (*storage.GatewayKey, *storage.GatewayGroup, error) {
	cacheKey, cacheable := rt.authCacheKey(ctx, hash)
	if cacheable {
		if raw, ok, err := rt.KV.Get(ctx, cacheKey); err == nil && ok {
			var snap authSnapshot
			if gob.NewDecoder(bytes.NewReader(raw)).Decode(&snap) == nil {
				return &snap.Key, &snap.Group, nil
			}
		}
	}
	key, err := rt.Keys.FindByHash(hash)
	if err != nil {
		return nil, nil, err
	}
	group, err := rt.Groups.FindByID(key.GroupID)
	if err != nil {
		return key, nil, err
	}
	if cacheable && key.Quota <= 0 {
		var buf bytes.Buffer
		if gob.NewEncoder(&buf).Encode(authSnapshot{Key: *key, Group: *group}) == nil {
			_ = rt.KV.Set(ctx, cacheKey, buf.Bytes(), authCacheTTL)
		}
	}
	return key, group, nil
}

// touchKey 更新密钥最近使用时间，同一密钥每分钟最多写一次库（多实例共享节流）。
func (rt *Runtime) touchKey(ctx context.Context, keyID uint) {
	if !kv.Throttle(ctx, rt.KV, fmt.Sprintf("gw:touch:%d", keyID), touchKeyWindow) {
		return
	}
	_ = rt.Keys.TouchLastUsed(keyID, time.Now())
}

func modelsCacheKey(groupID uint) string { return fmt.Sprintf("gw:models:%d", groupID) }
