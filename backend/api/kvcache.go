package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
)

// statsCacheTTL 看板聚合接口的结果缓存时间：前端自动刷新 / 多人同时打开看板时，
// 同一个查询在这段时间内只真正算一次。数据最多晚这么几秒，对统计看板可以接受。
const statsCacheTTL = 10 * time.Second

// bodyRecorder 记录响应体，命中 200 时写入缓存。
type bodyRecorder struct {
	gin.ResponseWriter
	buf bytes.Buffer
}

func (w *bodyRecorder) Write(b []byte) (int, error) {
	w.buf.Write(b)
	return w.ResponseWriter.Write(b)
}

func (w *bodyRecorder) WriteString(s string) (int, error) {
	w.buf.WriteString(s)
	return w.ResponseWriter.WriteString(s)
}

// cachedGET 给只读的聚合接口套一层短 TTL 结果缓存（kv：配置了 Redis 时多实例共享）。
// 缓存键 = 路径 + 规范化后的查询参数；只缓存 200 的 JSON 响应；kv 不可用时直接执行原 handler。
func cachedGET(d *Deps, ttl time.Duration, h gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		if d.KV == nil {
			h(c)
			return
		}
		// url.Values.Encode 按 key 排序，参数顺序不同的同一查询共用缓存
		query, _ := url.ParseQuery(c.Request.URL.RawQuery)
		sum := sha256.Sum256([]byte(c.Request.URL.Path + "?" + query.Encode()))
		key := "api:cache:" + hex.EncodeToString(sum[:16])

		ctx, cancel := context.WithTimeout(c.Request.Context(), 300*time.Millisecond)
		body, ok, err := d.KV.Get(ctx, key)
		cancel()
		if err == nil && ok {
			c.Header("X-Cache", "HIT")
			c.Data(http.StatusOK, "application/json; charset=utf-8", body)
			return
		}

		rec := &bodyRecorder{ResponseWriter: c.Writer}
		c.Writer = rec
		c.Header("X-Cache", "MISS")
		h(c)
		if rec.Status() == http.StatusOK && rec.buf.Len() > 0 {
			setCtx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			_ = d.KV.Set(setCtx, key, rec.buf.Bytes(), ttl)
			cancel()
		}
	}
}
