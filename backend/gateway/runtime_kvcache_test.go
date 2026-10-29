package gateway

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/bejix/upstream-ops/backend/kv"
	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
)

func TestAuthenticateUsesCacheAndInvalidatesOnAdminChange(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := openGatewayTestDB(t)
	groups := storage.NewGatewayGroups(db)
	keys := storage.NewGatewayKeys(db)
	svc := NewService(groups, keys, storage.NewGatewayRoutes(db), nil, nil, nil, nil, nil, nil)
	store := kv.NewMemory()
	t.Cleanup(func() { _ = store.Close() })
	svc.SetKV(store)
	if err := storage.OnGatewayAuthChange(db, svc.InvalidateAuthCache); err != nil {
		t.Fatalf("register invalidation: %v", err)
	}

	g := &storage.GatewayGroup{Name: "g", Status: storage.GatewayGroupStatusActive, ModelsMode: storage.GatewayModelsModeAuto}
	if err := groups.Create(g); err != nil {
		t.Fatalf("group: %v", err)
	}
	const raw = "sk-cache-test"
	k := &storage.GatewayKey{GroupID: g.ID, Name: "k", KeyHash: HashAPIKey(raw), KeyPrefix: "sk-c", KeyCipher: "x", Status: storage.GatewayKeyStatusActive}
	if err := keys.Create(k); err != nil {
		t.Fatalf("key: %v", err)
	}

	auth := func() (*AuthResult, error) {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/v1/models", nil)
		c.Request.Header.Set("Authorization", "Bearer "+raw)
		return svc.Runtime.Authenticate(c)
	}
	if _, err := auth(); err != nil {
		t.Fatalf("first auth: %v", err)
	}
	// 绕过 GORM 回调直接改库：缓存命中时看不到这次修改，证明第二次鉴权确实走了缓存
	if err := db.Exec("UPDATE gateway_keys SET name = 'renamed-behind-cache' WHERE id = ?", k.ID).Error; err != nil {
		t.Fatalf("raw update: %v", err)
	}
	res, err := auth()
	if err != nil || res.Key.Name != "k" {
		t.Fatalf("second auth should be served from cache, got %+v %v", res, err)
	}

	// 管理端走 GORM 的修改必须立即生效
	k.Status = "disabled"
	if err := keys.Update(k); err != nil {
		t.Fatalf("disable key: %v", err)
	}
	if _, err := auth(); err == nil || err.Error() != "api key disabled" {
		t.Fatalf("disabled key must be rejected immediately, got %v", err)
	}
	k.Status = storage.GatewayKeyStatusActive
	_ = keys.Update(k)
	g.Status = "disabled"
	if err := groups.Update(g); err != nil {
		t.Fatalf("disable group: %v", err)
	}
	if _, err := auth(); err == nil || err.Error() != "gateway group disabled" {
		t.Fatalf("disabled group must be rejected immediately, got %v", err)
	}
}

func TestAuthenticateSkipsCacheForQuotaKeys(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := openGatewayTestDB(t)
	groups := storage.NewGatewayGroups(db)
	keys := storage.NewGatewayKeys(db)
	svc := NewService(groups, keys, storage.NewGatewayRoutes(db), nil, nil, nil, nil, nil, nil)
	if err := storage.OnGatewayAuthChange(db, svc.InvalidateAuthCache); err != nil {
		t.Fatalf("register: %v", err)
	}
	g := &storage.GatewayGroup{Name: "g", Status: storage.GatewayGroupStatusActive, ModelsMode: storage.GatewayModelsModeAuto}
	_ = groups.Create(g)
	const raw = "sk-quota"
	k := &storage.GatewayKey{GroupID: g.ID, Name: "q", KeyHash: HashAPIKey(raw), KeyPrefix: "sk-q", KeyCipher: "x", Status: storage.GatewayKeyStatusActive, Quota: 1}
	_ = keys.Create(k)

	auth := func() error {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/v1/models", nil)
		c.Request.Header.Set("Authorization", "Bearer "+raw)
		_, err := svc.Runtime.Authenticate(c)
		return err
	}
	if err := auth(); err != nil {
		t.Fatalf("first auth: %v", err)
	}
	// quota_used 是热列，不触发失效；有额度的密钥必须每次读库才能及时拦截超额
	if err := keys.AddQuotaUsed(k.ID, 2); err != nil {
		t.Fatalf("add quota: %v", err)
	}
	if err := auth(); err == nil {
		t.Fatalf("over-quota key must be rejected on the next request")
	}
	if _, ok, _ := svc.KV.Get(context.Background(), "gw:auth:0:"+HashAPIKey(raw)); ok {
		t.Fatalf("quota keys must not be cached")
	}
}
