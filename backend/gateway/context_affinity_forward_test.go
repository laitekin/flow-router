package gateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/bejix/upstream-ops/backend/crypto"
	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
)

func TestForwardPinsContextAndDoesNotFallback(t *testing.T) {
	var hitA, hitB atomic.Int32
	var failA atomic.Bool
	makeUpstream := func(hits *atomic.Int32, canFail bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			if canFail && failA.Load() {
				http.Error(w, `{"error":{"message":"unavailable"}}`, 503)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"resp_next","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}`))
		}))
	}
	a, b := makeUpstream(&hitA, true), makeUpstream(&hitB, false)
	defer a.Close()
	defer b.Close()
	db := openGatewayTestDB(t)
	gr, kr := storage.NewGatewayGroups(db), storage.NewGatewayKeys(db)
	rr, pr := storage.NewGatewayRoutes(db), storage.NewGatewayProviders(db)
	cipher, err := crypto.NewCipher("test-only-secret")
	if err != nil {
		t.Fatal(err)
	}
	encrypted, _ := cipher.Encrypt("test-upstream-key")
	group := &storage.GatewayGroup{Name: "affinity-test", Status: storage.GatewayGroupStatusActive, ModelsMode: "manual", ModelsJSON: `[{"id":"gpt-6-sol"}]`, RateSortDirection: "asc", RetryEnabled: true, FailoverEnabled: true, FailoverMax: 1}
	if err := gr.Create(group); err != nil {
		t.Fatal(err)
	}
	pa := &storage.GatewayProvider{Name: "a", BaseURL: a.URL, APIKeyCipher: encrypted, Enabled: true}
	pb := &storage.GatewayProvider{Name: "b", BaseURL: b.URL, APIKeyCipher: encrypted, Enabled: true}
	if err := pr.Create(pa); err != nil {
		t.Fatal(err)
	}
	if err := pr.Create(pb); err != nil {
		t.Fatal(err)
	}
	if err := rr.SaveForGroup(group.ID, []storage.GatewayRoute{
		{SourceKind: "provider", GatewayProviderID: pa.ID, Enabled: true, RateConvertMode: "custom", RateConvertValue: 2},
		{SourceKind: "provider", GatewayProviderID: pb.ID, Enabled: true, RateConvertMode: "custom", RateConvertValue: 1},
	}); err != nil {
		t.Fatal(err)
	}
	routes, _ := rr.ListByGroupID(group.ID)
	var routeA uint
	for _, route := range routes {
		if route.GatewayProviderID == pa.ID {
			routeA = route.ID
		}
	}
	key := &storage.GatewayKey{GroupID: group.ID, Name: "test", KeyHash: HashAPIKey("test-client"), KeyPrefix: KeyPrefix("test-client"), Status: storage.GatewayKeyStatusActive}
	if err := kr.Create(key); err != nil {
		t.Fatal(err)
	}
	refs := contextReferences([]byte(`{"previous_response_id":"resp_seed"}`), false)
	if err := rr.RememberContextRoute(key.ID, group.ID, routeA, refs); err != nil {
		t.Fatal(err)
	}
	svc := NewService(gr, kr, rr, storage.NewGatewayUsageLogs(db), nil, nil, nil, cipher, nil)
	svc.SetProviders(pr)
	call := func(model string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"model": model, "input": "test", "previous_response_id": "resp_seed"})
		w := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(w)
		ctx.Request = httptest.NewRequest("POST", "/v1/responses", strings.NewReader(string(body)))
		ctx.Request.Header.Set("Authorization", "Bearer test-client")
		svc.runtime().HandleForward(ctx, "/v1/responses", protocol.KindOpenAIResponses)
		return w
	}
	if w := call("gpt-6-sol"); w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if hitA.Load() != 1 || hitB.Load() != 0 {
		t.Fatal("context was sent to cheaper foreign route")
	}
	failA.Store(true)
	if w := call("gpt-6-sol"); w.Code != 503 {
		t.Fatalf("failure status=%d body=%s", w.Code, w.Body.String())
	}
	if hitB.Load() != 0 {
		t.Fatal("stateful request failed over")
	}
	if w := call("deepseek-v4-flash"); w.Code != 404 {
		t.Fatalf("unknown model status=%d", w.Code)
	}
	if hitA.Load() != 2 || hitB.Load() != 0 {
		t.Fatal("unknown model reached upstream")
	}
}
