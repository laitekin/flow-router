package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/crypto"
	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/bejix/upstream-ops/backend/storage"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type healthFixture struct {
	svc            *Service
	db             *gorm.DB
	group          *storage.GatewayGroup
	routeA, routeB uint
	hitsA, hitsB   atomic.Int32
	mode           atomic.Int32 // 0=healthy, 1=503 before output, 2=truncated SSE
}

func newHealthFixture(t *testing.T) *healthFixture {
	t.Helper()
	f := &healthFixture{db: openGatewayTestDB(t)}
	upstream := func(primary bool) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var n int32
			var source string
			if primary {
				n = f.hitsA.Add(1)
				source = "a"
			} else {
				n = f.hitsB.Add(1)
				source = "b"
			}
			var body struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if primary && body.Model == "gpt-sol" && (f.mode.Load() == 3 || f.mode.Load() == 4) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(403)
				if f.mode.Load() == 3 {
					fmt.Fprint(w, `{"error":{"message":"Insufficient account balance"}}`)
				} else {
					fmt.Fprint(w, `{"error":{"message":"permission denied"}}`)
				}
				return
			}
			if primary && body.Model == "gpt-sol" && f.mode.Load() == 1 {
				http.Error(w, `{"error":{"message":"temporarily unavailable"}}`, 503)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_%s_%d\"}}\n\n", source, n)
			w.(http.Flusher).Flush()
			if primary && body.Model == "gpt-sol" && f.mode.Load() == 2 {
				return
			}
			fmt.Fprintf(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_%s_%d\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n", source, n)
		}))
	}
	a, b := upstream(true), upstream(false)
	t.Cleanup(a.Close)
	t.Cleanup(b.Close)
	gr, kr, rr, pr := storage.NewGatewayGroups(f.db), storage.NewGatewayKeys(f.db), storage.NewGatewayRoutes(f.db), storage.NewGatewayProviders(f.db)
	cipher, err := crypto.NewCipher("test-health-only")
	if err != nil {
		t.Fatal(err)
	}
	enc, _ := cipher.Encrypt("test-upstream")
	f.group = &storage.GatewayGroup{Name: "health-test", Status: "active", ModelsMode: "manual", ModelsJSON: `[{"id":"gpt-sol"},{"id":"gpt-astra"}]`, RateSortDirection: "asc", RetryEnabled: true, FailoverEnabled: true, FailoverMax: 1, CooldownSeconds: 60}
	if err := gr.Create(f.group); err != nil {
		t.Fatal(err)
	}
	pa := &storage.GatewayProvider{Name: "primary", BaseURL: a.URL, APIKeyCipher: enc, Enabled: true}
	pb := &storage.GatewayProvider{Name: "backup", BaseURL: b.URL, APIKeyCipher: enc, Enabled: true}
	if err := pr.Create(pa); err != nil {
		t.Fatal(err)
	}
	if err := pr.Create(pb); err != nil {
		t.Fatal(err)
	}
	if err := rr.SaveForGroup(f.group.ID, []storage.GatewayRoute{{SourceKind: "provider", GatewayProviderID: pa.ID, Enabled: true, RateConvertMode: "custom", RateConvertValue: 1}, {SourceKind: "provider", GatewayProviderID: pb.ID, Enabled: true, RateConvertMode: "custom", RateConvertValue: 2}}); err != nil {
		t.Fatal(err)
	}
	routes, _ := rr.ListByGroupID(f.group.ID)
	for _, route := range routes {
		if route.GatewayProviderID == pa.ID {
			f.routeA = route.ID
		} else {
			f.routeB = route.ID
		}
	}
	if err := kr.Create(&storage.GatewayKey{GroupID: f.group.ID, Name: "health-key", KeyHash: HashAPIKey("test-health-key"), KeyPrefix: KeyPrefix("test-health-key"), Status: "active"}); err != nil {
		t.Fatal(err)
	}
	f.svc = NewService(gr, kr, rr, storage.NewGatewayUsageLogs(f.db), nil, nil, nil, cipher, nil)
	f.svc.SetProviders(pr)
	return f
}

func (f *healthFixture) call(model, previous string, ctx context.Context) *httptest.ResponseRecorder {
	body := map[string]any{"model": model, "input": "test", "stream": true}
	if previous != "" {
		body["previous_response_id"] = previous
	}
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/v1/responses", strings.NewReader(string(raw))).WithContext(ctx)
	c.Request.Header.Set("Authorization", "Bearer test-health-key")
	f.svc.runtime().HandleForward(c, "/v1/responses", protocol.KindOpenAIResponses)
	return w
}

func TestPostCommitFailureCoolsOnlyModelAndNextRequestUsesBackup(t *testing.T) {
	f := newHealthFixture(t)
	f.mode.Store(2)
	w := f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || !strings.Contains(w.Body.String(), "stream_incomplete") || f.hitsB.Load() != 0 {
		t.Fatalf("partial stream was replayed or hidden: %d %s", w.Code, w.Body.String())
	}
	cd, err := f.svc.Routes.ModelCooldowns([]uint{f.routeA}, "gpt-sol", time.Now())
	if err != nil || len(cd) != 1 {
		t.Fatalf("missing cooldown: %v %v", cd, err)
	}
	var usage storage.GatewayUsageLog
	if err := f.db.Where("route_id = ? AND success = ?", f.routeA, false).First(&usage).Error; err != nil {
		t.Fatal(err)
	}
	if usage.CooldownUntil == nil || !strings.Contains(usage.ErrorMessage, "last_event=") {
		t.Fatalf("diagnostic/cooldown missing: %+v", usage)
	}
	w = f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") || f.hitsA.Load() != 1 || f.hitsB.Load() != 1 {
		t.Fatal("next fresh request did not bypass cooled route")
	}
	w = f.call("gpt-astra", "", context.Background())
	if w.Code != 200 || f.hitsA.Load() != 2 {
		t.Fatal("Sol failure blocked Astra")
	}
	w = f.call("gpt-sol", "resp_a_1", context.Background())
	if w.Code != 503 || w.Header().Get("Retry-After") == "" || f.hitsB.Load() != 1 {
		t.Fatal("stateful context escaped to another upstream")
	}
	_, _ = f.svc.Routes.NoteModelFailure(f.routeB, "gpt-sol", "busy", "test", time.Minute, time.Now())
	w = f.call("gpt-sol", "", context.Background())
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatal("all-cooled response lacks retry guidance")
	}
	if err := f.db.Model(&storage.GatewayModelCooldown{}).Where("route_id = ?", f.routeA).Update("cooldown_until", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	f.mode.Store(0)
	w = f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || f.hitsA.Load() != 3 {
		t.Fatal("expired primary did not recover")
	}
}

func TestPreCommitFailureFailsOverWithinSameRequest(t *testing.T) {
	f := newHealthFixture(t)
	f.mode.Store(1)
	w := f.call("gpt-sol", "", context.Background())
	if w.Code != 200 || !strings.Contains(w.Body.String(), "response.completed") || f.hitsA.Load() != 1 || f.hitsB.Load() != 1 {
		t.Fatalf("precommit failover failed: %d %s", w.Code, w.Body.String())
	}
	var rows []storage.GatewayUsageLog
	f.db.Order("id").Find(&rows)
	if len(rows) != 2 || rows[1].AttemptKind != "failover" || rows[1].Attempt != 2 {
		t.Fatal("attempt audit missing")
	}
	route, _ := f.svc.Routes.FindByID(f.routeA)
	if route.TempUnschedulableUntil != nil {
		t.Fatal("model error caused route-wide pause")
	}
}

func TestCanceledClientDoesNotCoolModel(t *testing.T) {
	f := newHealthFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.call("gpt-sol", "", ctx)
	rows, err := f.svc.Routes.ActiveModelCooldowns(time.Now())
	if err != nil || len(rows) != 0 {
		t.Fatalf("client cancellation cooled upstream: %v %v", rows, err)
	}
}
