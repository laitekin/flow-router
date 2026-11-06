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
	"github.com/bejix/upstream-ops/backend/storage"
)

func TestIsImageGenerationModel(t *testing.T) {
	for model, want := range map[string]bool{
		"gpt-image-1": true, "gpt-image-1.5": true, "dall-e-3": true, "openai/dall-e-2": true,
		"flux-1.1-pro": true, "black-forest-labs/flux-schnell": true, "imagen-4.0-generate-001": true,
		"doubao-seedream-4-0": true, "stable-diffusion-xl": true, "sd3.5-large": true, "grok-2-image": true,
		"grok-imagine-image": true, "qwen-image": true, "cogview-4": true, "midjourney": true,
		"gpt-4o": false, "gpt-5": false, "claude-sonnet-4-5": false, "deepseek-chat": false,
		"gemini-2.5-flash-image": false, "gpt-4o-image": false, "o3-mini": false, "": false,
	} {
		if got := isImageGenerationModel(model); got != want {
			t.Errorf("%q: got %v want %v", model, got, want)
		}
	}
}

func TestParseImageProbeResponse(t *testing.T) {
	r := parseImageProbeResponse([]byte(`{"data":[{"b64_json":"aGk=","revised_prompt":"apple"}],"output_format":"webp","usage":{"input_tokens":10,"output_tokens":272}}`), true)
	if r.Err != "" || len(r.Images) != 1 || r.Images[0] != "data:image/webp;base64,aGk=" || r.RevisedPrompt != "apple" || r.OutputTokens == nil || *r.OutputTokens != 272 {
		t.Fatalf("b64: %+v", r)
	}
	r = parseImageProbeResponse([]byte(`{"data":[{"url":"https://img.example/a.png"}]}`), true)
	if r.Err != "" || r.Images[0] != "https://img.example/a.png" {
		t.Fatalf("url: %+v", r)
	}
	if r = parseImageProbeResponse([]byte(`{"data":[]}`), true); r.Err == "" {
		t.Fatal("empty data must fail")
	}
	if r = parseImageProbeResponse([]byte(`{"error":{"message":"insufficient balance"}}`), true); !strings.Contains(r.Err, "insufficient") {
		t.Fatalf("200 with error: %+v", r)
	}
}

type imageFixture struct {
	svc        *Service
	group      *storage.GatewayGroup
	routeID    uint
	imageHits  atomic.Int32
	chatHits   atomic.Int32
	noImages   atomic.Bool // 上游没有 images 端点
	lastBody   atomic.Value
	failStatus atomic.Int32
}

func newImageFixture(t *testing.T) *imageFixture {
	t.Helper()
	f := &imageFixture{}
	db := openGatewayTestDB(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		f.lastBody.Store(string(raw))
		switch {
		case strings.HasSuffix(r.URL.Path, "/images/generations"):
			f.imageHits.Add(1)
			if f.noImages.Load() {
				http.NotFound(w, r)
				return
			}
			if s := f.failStatus.Load(); s != 0 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(int(s))
				fmt.Fprint(w, `{"error":{"message":"Insufficient account balance"}}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"created":1,"data":[{"b64_json":"aGVsbG8="}],"usage":{"input_tokens":12,"output_tokens":272}}`)
		default:
			f.chatHits.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
		}
	}))
	t.Cleanup(up.Close)
	gr, kr, rr, pr := storage.NewGatewayGroups(db), storage.NewGatewayKeys(db), storage.NewGatewayRoutes(db), storage.NewGatewayProviders(db)
	cipher, err := crypto.NewCipher("test-image-only")
	if err != nil {
		t.Fatal(err)
	}
	enc, _ := cipher.Encrypt("test-upstream")
	f.group = &storage.GatewayGroup{Name: "image-test", Status: "active", ModelsMode: "manual", ModelsJSON: `[{"id":"gpt-image-1"},{"id":"gpt-4o-mini"}]`, RateSortDirection: "asc", CooldownSeconds: 60}
	if err := gr.Create(f.group); err != nil {
		t.Fatal(err)
	}
	p := &storage.GatewayProvider{Name: "img", BaseURL: up.URL, APIKeyCipher: enc, Enabled: true}
	if err := pr.Create(p); err != nil {
		t.Fatal(err)
	}
	if err := rr.SaveForGroup(f.group.ID, []storage.GatewayRoute{{SourceKind: "provider", GatewayProviderID: p.ID, Enabled: true, RateConvertMode: "custom", RateConvertValue: 1}}); err != nil {
		t.Fatal(err)
	}
	routes, _ := rr.ListByGroupID(f.group.ID)
	f.routeID = routes[0].ID
	f.svc = NewService(gr, kr, rr, storage.NewGatewayUsageLogs(db), nil, nil, nil, cipher, nil)
	f.svc.SetProviders(pr)
	return f
}

func TestModelTestUsesImagesEndpointForImageModels(t *testing.T) {
	f := newImageFixture(t)
	res, err := f.svc.TestGroupModel(context.Background(), f.group.ID, TestModelInput{Model: "gpt-image-1", RouteID: &f.routeID})
	if err != nil || len(res) != 1 || !res[0].OK || res[0].UpstreamPath != imageProbePath || f.imageHits.Load() != 1 || f.chatHits.Load() != 0 {
		t.Fatalf("image test: %+v err=%v", res, err)
	}
	body := f.lastBody.Load().(string)
	if !strings.Contains(body, `"quality":"low"`) || strings.Contains(body, "response_format") || strings.Contains(body, "messages") {
		t.Fatalf("unexpected body %s", body)
	}
	// 聊天模型保持原行为
	res, err = f.svc.TestGroupModel(context.Background(), f.group.ID, TestModelInput{Model: "gpt-4o-mini", RouteID: &f.routeID})
	if err != nil || !res[0].OK || f.chatHits.Load() != 1 || f.imageHits.Load() != 1 {
		t.Fatalf("chat test: %+v err=%v", res, err)
	}
	// 强制 chat
	res, _ = f.svc.TestGroupModel(context.Background(), f.group.ID, TestModelInput{Model: "gpt-image-1", RouteID: &f.routeID, Mode: "chat"})
	if !res[0].OK || f.chatHits.Load() != 2 || f.imageHits.Load() != 1 {
		t.Fatal("mode=chat not honoured")
	}
}

func TestModelTestImageFallsBackToChatWithoutImagesEndpoint(t *testing.T) {
	f := newImageFixture(t)
	f.noImages.Store(true)
	res, err := f.svc.TestGroupModel(context.Background(), f.group.ID, TestModelInput{Model: "gpt-image-1", RouteID: &f.routeID})
	if err != nil || !res[0].OK || f.imageHits.Load() != 1 || f.chatHits.Load() != 1 || res[0].UpstreamPath == imageProbePath {
		t.Fatalf("fallback: %+v err=%v", res, err)
	}
}

func TestReleaseCooldownWorksForImageRoutes(t *testing.T) {
	f := newImageFixture(t)
	if _, err := f.svc.Routes.NoteModelFailure(f.routeID, "gpt-image-1", "upstream 503", "req", time.Minute, time.Now()); err != nil {
		t.Fatal(err)
	}
	f.failStatus.Store(403)
	res, err := f.svc.ReleaseRouteCooldown(context.Background(), f.routeID, ReleaseCooldownInput{})
	if err != nil || res.Released || res.Tests[0].StatusCode != 403 || !strings.Contains(strings.ToLower(res.Tests[0].Error), "insufficient") {
		t.Fatalf("failed image test must keep cooldown: %+v err=%v", res, err)
	}
	f.failStatus.Store(0)
	res, err = f.svc.ReleaseRouteCooldown(context.Background(), f.routeID, ReleaseCooldownInput{})
	if err != nil || !res.Released || len(res.ClearedModels) != 1 || res.Remaining.Active() {
		t.Fatalf("image release: %+v err=%v", res, err)
	}
}

func TestProbeBenchImageMode(t *testing.T) {
	f := newImageFixture(t)
	var samples []ModelProbeSample
	var proto string
	err := f.svc.ProbeModel(context.Background(), f.group.ID, ModelProbeInput{
		Model: "gpt-image-1", RouteID: f.routeID,
		Rounds: []ProbeRound{{Messages: []ProbeMessage{{Role: "user", Content: "a pelican riding a bicycle"}}}},
	}, func(ev ModelProbeEvent) error {
		if ev.Stage == "started" {
			proto = ev.Protocol
		}
		if ev.Sample != nil {
			samples = append(samples, *ev.Sample)
		}
		return nil
	})
	if err != nil || proto != "image" || len(samples) != 1 || !samples[0].OK || len(samples[0].Images) != 1 ||
		!strings.HasPrefix(samples[0].Images[0], "data:image/png;base64,") || samples[0].OutputTokens == nil {
		t.Fatalf("bench: proto=%s %+v err=%v", proto, samples, err)
	}
	if body := f.lastBody.Load().(string); !strings.Contains(body, "pelican") {
		t.Fatalf("prompt not sent: %s", body)
	}
}
