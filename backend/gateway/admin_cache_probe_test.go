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
)

func TestCacheProbeUsageDistinguishesMissingZeroAndHits(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		kind          protocolKind
		input, cached int
	}{
		{"responses missing", `{"response":{"usage":{"input_tokens":4000}}}`, protocol.KindOpenAIResponses, 4000, -1},
		{"responses null", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":null}}}}`, protocol.KindOpenAIResponses, 4000, -1},
		{"responses zero", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":0}}}}`, protocol.KindOpenAIResponses, 4000, 0},
		{"responses hit", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":3712}}}}`, protocol.KindOpenAIResponses, 4000, 3712},
		{"deepseek chat", `{"usage":{"prompt_tokens":4000,"prompt_cache_hit_tokens":3712,"prompt_cache_miss_tokens":288}}`, protocol.KindOpenAIChat, 4000, 3712},
		{"anthropic exclusive buckets", `{"message":{"usage":{"input_tokens":100,"cache_read_input_tokens":3000,"cache_creation_input_tokens":900}}}`, protocol.KindAnthropic, 4000, 3000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var raw map[string]any
			if err := json.Unmarshal([]byte(tc.payload), &raw); err != nil {
				t.Fatal(err)
			}
			var sample CacheTestSample
			mergeCacheTestUsage(&sample, raw, tc.kind)
			if sample.InputTokens == nil || *sample.InputTokens != tc.input {
				t.Fatalf("input: %+v", sample)
			}
			if tc.cached < 0 {
				if sample.CachedTokens != nil {
					t.Fatal("missing/null field became a cache miss")
				}
				return
			}
			if sample.CachedTokens == nil || *sample.CachedTokens != tc.cached {
				t.Fatalf("cached: %+v", sample)
			}
		})
	}
}

func newCacheProbeTestService(t *testing.T, url string) (*Service, *storage.GatewayGroup, storage.GatewayRoute) {
	t.Helper()
	db := openGatewayTestDB(t)
	cipher, err := crypto.NewCipher("cache-probe-test")
	if err != nil {
		t.Fatal(err)
	}
	secret, err := cipher.Encrypt("upstream-private-secret")
	if err != nil {
		t.Fatal(err)
	}
	providers := storage.NewGatewayProviders(db)
	p := &storage.GatewayProvider{Name: "chosen-source", BaseURL: url, APIKeyCipher: secret, UpstreamProtocol: "openai_responses", Enabled: true}
	if err := providers.Create(p); err != nil {
		t.Fatal(err)
	}
	groups, routes := storage.NewGatewayGroups(db), storage.NewGatewayRoutes(db)
	g := &storage.GatewayGroup{Name: "cache-probe", Status: "active", ModelsJSON: `[{"id":"deepseek-v4-pro","source":"custom"}]`}
	if err := groups.Create(g); err != nil {
		t.Fatal(err)
	}
	if err := routes.SaveForGroup(g.ID, []storage.GatewayRoute{{SourceKind: "provider", GatewayProviderID: p.ID, Enabled: true, ModelMappingJSON: `{"deepseek-v4-pro":"deepseek-upstream"}`}}); err != nil {
		t.Fatal(err)
	}
	rs, err := routes.ListByGroupID(g.ID)
	if err != nil || len(rs) != 1 {
		t.Fatalf("routes: %v", err)
	}
	g.ModelsJSON = fmt.Sprintf(`[{"id":"deepseek-v4-pro","source":"custom","sources":[{"route_id":%d}]}]`, rs[0].ID)
	if err := groups.Update(g); err != nil {
		t.Fatal(err)
	}
	s := NewService(groups, nil, routes, nil, nil, nil, nil, cipher, nil)
	s.SetProviders(providers)
	return s, g, rs[0]
}

func TestCacheProbePinsSourceAndStreamsFiveRounds(t *testing.T) {
	var calls atomic.Int32
	var prompts []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer upstream-private-secret" {
			t.Error("wrong target/protocol/credential")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body["model"] != "deepseek-upstream" || body["stream"] != true {
			t.Error("mapping or stream lost")
		}
		input := body["input"].([]any)[0].(map[string]any)["content"].(string)
		prompts = append(prompts, input)
		n := calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\",\"response\":{}}\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(35 * time.Millisecond)
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n")
		details := ""
		if n > 1 {
			details = `,"input_tokens_details":{"cached_tokens":3712}`
		}
		fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4000%s}}}\n\n", details)
	}))
	defer up.Close()
	s, g, route := newCacheProbeTestService(t, up.URL)
	interval := 1
	var samples []CacheTestSample
	err := s.TestModelCache(context.Background(), g.ID, CacheTestInput{Model: "deepseek-v4-pro", RouteID: route.ID, IntervalSec: &interval}, func(ev CacheTestEvent) error {
		if ev.Sample != nil {
			samples = append(samples, *ev.Sample)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 5 || len(samples) != 5 {
		t.Fatalf("calls=%d samples=%d", calls.Load(), len(samples))
	}
	if samples[0].CachedTokens != nil {
		t.Fatal("unknown cold cache became zero")
	}
	for i, sample := range samples {
		if !sample.OK || sample.FirstTextMS == nil || *sample.FirstTextMS < 30 {
			t.Fatalf("round %d counted metadata as text: %+v", i, sample)
		}
	}
	if prompts[0] != prompts[1] || prompts[1] != prompts[2] || prompts[3] == prompts[4] || !strings.Contains(prompts[4], "Verification variant 5") {
		t.Fatal("experiment scenarios incorrect")
	}
	if samples[1].TokenHitRate == nil || *samples[1].TokenHitRate != .928 {
		t.Fatal("wrong total-input denominator")
	}
	// Reject a route outside this group before sending any upstream request.
	err = s.TestModelCache(context.Background(), g.ID, CacheTestInput{Model: "deepseek-v4-pro", RouteID: route.ID + 100}, func(CacheTestEvent) error { return nil })
	if err == nil || calls.Load() != 5 {
		t.Fatal("accepted another group's source")
	}
}

func TestCacheProbeCancellationStopsNextRound(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n")
	}))
	defer up.Close()
	s, g, route := newCacheProbeTestService(t, up.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	start := time.Now()
	err := s.TestModelCache(ctx, g.ID, CacheTestInput{Model: "deepseek-v4-pro", RouteID: route.ID}, func(ev CacheTestEvent) error {
		if ev.Sample != nil {
			cancel()
		}
		return nil
	})
	if err != context.Canceled || calls.Load() != 1 || time.Since(start) > time.Second {
		t.Fatalf("cancellation failed: %v calls=%d", err, calls.Load())
	}
}

func TestCacheProbeDoesNotExposeErrorBodyOrTreatMetadataAsText(t *testing.T) {
	for _, status := range []int{200, 403} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				if status == 403 {
					fmt.Fprint(w, "upstream-private-secret")
					return
				}
				fmt.Fprint(w, "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n")
			}))
			defer up.Close()
			s := NewService(nil, nil, nil, nil, nil, nil, nil, nil, nil)
			client := up.Client()
			sample := s.admin().cacheTestRequest(context.Background(), client, &upstreamTarget{BaseURL: up.URL, APIKey: "upstream-private-secret"}, []byte(`{}`), "/v1/responses", protocol.KindOpenAIResponses)
			if sample.OK || sample.FirstTextMS != nil || strings.Contains(sample.Error, "private-secret") {
				t.Fatalf("invalid success/error: %+v", sample)
			}
		})
	}
}
