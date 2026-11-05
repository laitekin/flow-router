package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bejix/upstream-ops/backend/crypto"
	"github.com/bejix/upstream-ops/backend/gateway/protocol"
	"github.com/bejix/upstream-ops/backend/storage"
)

func TestProbeUsageDistinguishesMissingZeroAndHits(t *testing.T) {
	for _, tc := range []struct {
		name, payload string
		kind          protocolKind
		input, cached int
		output        int
	}{
		{"responses missing", `{"response":{"usage":{"input_tokens":4000,"output_tokens":3}}}`, protocol.KindOpenAIResponses, 4000, -1, 3},
		{"responses null", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":null}}}}`, protocol.KindOpenAIResponses, 4000, -1, -1},
		{"responses zero", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":0}}}}`, protocol.KindOpenAIResponses, 4000, 0, -1},
		{"responses hit", `{"response":{"usage":{"input_tokens":4000,"input_tokens_details":{"cached_tokens":3712}}}}`, protocol.KindOpenAIResponses, 4000, 3712, -1},
		{"deepseek chat", `{"usage":{"prompt_tokens":4000,"completion_tokens":9,"prompt_cache_hit_tokens":3712,"prompt_cache_miss_tokens":288}}`, protocol.KindOpenAIChat, 4000, 3712, 9},
		{"anthropic exclusive buckets", `{"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":3000,"cache_creation_input_tokens":900}}}`, protocol.KindAnthropic, 4000, 3000, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var raw map[string]any
			if err := json.Unmarshal([]byte(tc.payload), &raw); err != nil {
				t.Fatal(err)
			}
			var sample ModelProbeSample
			mergeProbeUsage(&sample, raw, tc.kind)
			if sample.InputTokens == nil || *sample.InputTokens != tc.input {
				t.Fatalf("input: %+v", sample)
			}
			if tc.output >= 0 && (sample.OutputTokens == nil || *sample.OutputTokens != tc.output) {
				t.Fatalf("output: %+v", sample)
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

func TestProbeInputValidation(t *testing.T) {
	user := []ProbeRound{{Messages: []ProbeMessage{{Role: "user", Content: "hi"}}}}
	bad := []ModelProbeInput{
		{Model: "", RouteID: 1, Rounds: user},
		{Model: "m", RouteID: 1},
		{Model: "m", RouteID: 1, Rounds: []ProbeRound{{Messages: []ProbeMessage{{Role: "system", Content: "x"}}}}},
		{Model: "m", RouteID: 1, Rounds: []ProbeRound{{Messages: []ProbeMessage{{Role: "tool", Content: "x"}}}}},
		{Model: "m", RouteID: 1, Rounds: user, Reasoning: "max"},
		{Model: "m", RouteID: 1, Rounds: user, MaxTokens: probeMaxMaxTokens + 1},
		{Model: "m", RouteID: 1, Rounds: user, TimeoutSec: 1},
		{Model: "m", RouteID: 1, Rounds: user, Protocol: "anthropic"},
		{Model: "m", RouteID: 1, Rounds: make([]ProbeRound, probeMaxRounds+1)},
		{Model: "m", RouteID: 1, Rounds: []ProbeRound{{Messages: []ProbeMessage{{Role: "user", Content: strings.Repeat("x", probeMaxPromptBytes+1)}}}}},
	}
	for i, in := range bad {
		if err := normalizeProbeInput(&in); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	ok := ModelProbeInput{Model: " m ", RouteID: 1, Rounds: user}
	if err := normalizeProbeInput(&ok); err != nil || ok.MaxTokens != probeDefaultMaxTokens || ok.TimeoutSec != probeDefaultTimeout || ok.Rounds[0].Label != "第 1 轮" || ok.Model != "m" {
		t.Fatalf("defaults not applied: %v %+v", err, ok)
	}
}

func newProbeTestService(t *testing.T, url, upstreamProtocol string) (*Service, *storage.GatewayGroup, storage.GatewayRoute) {
	t.Helper()
	db := openGatewayTestDB(t)
	cipher, err := crypto.NewCipher("probe-test")
	if err != nil {
		t.Fatal(err)
	}
	secret, err := cipher.Encrypt("upstream-private-secret")
	if err != nil {
		t.Fatal(err)
	}
	providers := storage.NewGatewayProviders(db)
	p := &storage.GatewayProvider{Name: "chosen-source", BaseURL: url, APIKeyCipher: secret, UpstreamProtocol: upstreamProtocol, Enabled: true}
	if err := providers.Create(p); err != nil {
		t.Fatal(err)
	}
	groups, routes := storage.NewGatewayGroups(db), storage.NewGatewayRoutes(db)
	g := &storage.GatewayGroup{Name: "probe", Status: "active", ModelsJSON: `[{"id":"deepseek-v4-pro","source":"custom"}]`}
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

func userRound(label, text string) ProbeRound {
	return ProbeRound{Label: label, Messages: []ProbeMessage{{Role: "user", Content: text}}}
}

func TestProbePinsSourceAndStreamsCacheRounds(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	var bodies []map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer upstream-private-secret" {
			t.Error("wrong target/protocol/credential")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		n := calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\",\"response\":{}}\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(35 * time.Millisecond)
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"O\"}\n\n")
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"K\"}\n\n")
		details := ""
		if n > 1 {
			details = `,"input_tokens_details":{"cached_tokens":3712}`
		}
		fmt.Fprintf(w, "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4000,\"output_tokens\":2%s}}}\n\n", details)
	}))
	defer up.Close()
	s, g, route := newProbeTestService(t, up.URL, "openai_responses")
	interval := 0
	in := ModelProbeInput{Model: "deepseek-v4-pro", RouteID: route.ID, IntervalSec: &interval, Reasoning: "off", MaxTokens: 64,
		Rounds: []ProbeRound{userRound("cold", "A"), userRound("repeat", "A"), userRound("tail", "B")}}
	var samples []ModelProbeSample
	var started ModelProbeEvent
	err := s.ProbeModel(context.Background(), g.ID, in, func(ev ModelProbeEvent) error {
		if ev.Stage == "started" {
			started = ev
		}
		if ev.Sample != nil {
			samples = append(samples, *ev.Sample)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if started.UpstreamModel != "deepseek-upstream" || started.Label != "chosen-source" || started.Total != 3 {
		t.Fatalf("started: %+v", started)
	}
	if calls.Load() != 3 || len(samples) != 3 {
		t.Fatalf("calls=%d samples=%d", calls.Load(), len(samples))
	}
	if samples[0].CachedTokens != nil {
		t.Fatal("unknown cold cache became zero")
	}
	for i, sample := range samples {
		if !sample.OK || sample.Text != "OK" || sample.FirstTextMS == nil || *sample.FirstTextMS < 30 || sample.FinishReason != "completed" {
			t.Fatalf("round %d: %+v", i, sample)
		}
	}
	if samples[1].Label != "repeat" || samples[1].TokenHitRate == nil || *samples[1].TokenHitRate != .928 {
		t.Fatal("wrong label or total-input denominator")
	}
	b := bodies[0]
	if b["model"] != "deepseek-upstream" || b["stream"] != true || b["max_output_tokens"] != float64(64) {
		t.Fatalf("body: %v", b)
	}
	if r, _ := b["reasoning"].(map[string]any); r["effort"] != "none" {
		t.Fatalf("reasoning off not applied: %v", b)
	}
	// Reject a route outside this group before sending any upstream request.
	in.RouteID = route.ID + 100
	if err = s.ProbeModel(context.Background(), g.ID, in, func(ModelProbeEvent) error { return nil }); err == nil || calls.Load() != 3 {
		t.Fatal("accepted another group's source")
	}
}

func TestProbeChatCapturesTextReasoningAndSystemPrompt(t *testing.T) {
	var got map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, chunk := range []string{
			`{"choices":[{"delta":{"reasoning_content":"thinking…"}}]}`,
			`{"choices":[{"delta":{"content":"<svg viewBox=\"0 0 10 10\">"}}]}`,
			`{"choices":[{"delta":{"content":"</svg>"},"finish_reason":"stop"}]}`,
			`{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":40,"completion_tokens_details":{"reasoning_tokens":30}}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			w.(http.Flusher).Flush()
			time.Sleep(30 * time.Millisecond)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	s, g, route := newProbeTestService(t, up.URL, "openai_chat")
	temp := 0.2
	in := ModelProbeInput{Model: "deepseek-v4-pro", RouteID: route.ID, Temperature: &temp, Reasoning: "high",
		Rounds: []ProbeRound{{Label: "pelican", Messages: []ProbeMessage{{Role: "system", Content: "be terse"}, {Role: "user", Content: "draw"}}}}}
	var sample *ModelProbeSample
	if err := s.ProbeModel(context.Background(), g.ID, in, func(ev ModelProbeEvent) error {
		if ev.Sample != nil {
			sample = ev.Sample
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if sample == nil || !sample.OK || sample.Text != `<svg viewBox="0 0 10 10"></svg>` || sample.ReasoningChars == 0 || sample.FinishReason != "stop" {
		t.Fatalf("sample: %+v", sample)
	}
	if sample.FirstTokenMS == nil || sample.FirstTextMS == nil || *sample.FirstTokenMS >= *sample.FirstTextMS {
		t.Fatalf("first token should precede first text: %+v", sample)
	}
	if sample.OutputTokens == nil || *sample.OutputTokens != 40 || sample.ReasoningTokens == nil || *sample.ReasoningTokens != 30 || sample.OutputTPS == nil {
		t.Fatalf("usage: %+v", sample)
	}
	msgs, _ := got["messages"].([]any)
	if len(msgs) != 2 || got["temperature"] != 0.2 || got["reasoning_effort"] != "high" {
		t.Fatalf("request: %v", got)
	}
	if th, _ := got["thinking"].(map[string]any); th["type"] != "enabled" {
		t.Fatalf("deepseek thinking not enabled: %v", got)
	}
}

func TestProbeCancellationStopsNextRound(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n")
	}))
	defer up.Close()
	s, g, route := newProbeTestService(t, up.URL, "openai_responses")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	interval := 5
	start := time.Now()
	err := s.ProbeModel(ctx, g.ID, ModelProbeInput{Model: "deepseek-v4-pro", RouteID: route.ID, IntervalSec: &interval,
		Rounds: []ProbeRound{userRound("", "a"), userRound("", "b")}}, func(ev ModelProbeEvent) error {
		if ev.Sample != nil {
			cancel()
		}
		return nil
	})
	if err != context.Canceled || calls.Load() != 1 || time.Since(start) > time.Second {
		t.Fatalf("cancellation failed: %v calls=%d", err, calls.Load())
	}
}

func TestProbeStopsAfterFailureUnlessContinue(t *testing.T) {
	var calls atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"model not found for key upstream-private-secret"}}`)
	}))
	defer up.Close()
	s, g, route := newProbeTestService(t, up.URL, "openai_responses")
	rounds := []ProbeRound{userRound("", "a"), userRound("", "b")}
	var last *ModelProbeSample
	collect := func(ev ModelProbeEvent) error {
		if ev.Sample != nil {
			last = ev.Sample
		}
		return nil
	}
	if err := s.ProbeModel(context.Background(), g.ID, ModelProbeInput{Model: "deepseek-v4-pro", RouteID: route.ID, Rounds: rounds}, collect); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 || last.OK || !strings.Contains(last.Error, "model not found") || strings.Contains(last.Error, "private-secret") {
		t.Fatalf("calls=%d sample=%+v", calls.Load(), last)
	}
	if err := s.ProbeModel(context.Background(), g.ID, ModelProbeInput{Model: "deepseek-v4-pro", RouteID: route.ID, Rounds: rounds, ContinueOnError: true}, collect); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Fatalf("continue_on_error ignored: %d", calls.Load())
	}
}

func TestProbeRejectsMetadataOnlyAndReasoningOnlyStreams(t *testing.T) {
	for name, stream := range map[string]string{
		"metadata":  "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
		"reasoning": "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"hmm\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, stream) }))
			defer up.Close()
			s := NewService(nil, nil, nil, nil, nil, nil, nil, nil, nil)
			sample := s.admin().probeRequest(context.Background(), up.Client(), &upstreamTarget{BaseURL: up.URL, APIKey: "k"}, []byte(`{}`), "/v1/responses", protocol.KindOpenAIResponses, 5*time.Second)
			if sample.OK || sample.FirstTextMS != nil || sample.Error == "" {
				t.Fatalf("invalid success: %+v", sample)
			}
			if name == "reasoning" && (sample.FirstTokenMS == nil || !strings.Contains(sample.Error, "max_tokens")) {
				t.Fatalf("reasoning-only not explained: %+v", sample)
			}
		})
	}
}

func TestProbeAcceptsNonStreamingJSONFallback(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}`)
	}))
	defer up.Close()
	s := NewService(nil, nil, nil, nil, nil, nil, nil, nil, nil)
	sample := s.admin().probeRequest(context.Background(), up.Client(), &upstreamTarget{BaseURL: up.URL, APIKey: "k"}, []byte(`{}`), "/v1/chat/completions", protocol.KindOpenAIChat, 5*time.Second)
	if !sample.OK || sample.Text != "hello" || sample.OutputTokens == nil || *sample.OutputTokens != 1 {
		t.Fatalf("sample: %+v", sample)
	}
}
