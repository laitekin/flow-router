package sub2api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bejix/upstream-ops/backend/connector"
)

func TestProbeSiteDetectsSub2API(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/settings/public" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"message":"success","data":{"site_name":"S2","turnstile_enabled":true,"turnstile_site_key":"0xBBB","linuxdo_connect_enabled":true}}`))
	}))
	defer srv.Close()

	info, err := New().ProbeSite(context.Background(), &connector.Channel{SiteURL: srv.URL})
	if err != nil {
		t.Fatalf("ProbeSite: %v", err)
	}
	if info.Type != connector.TypeSub2API || info.SiteName != "S2" || !info.TurnstileEnabled {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestProbeSiteRejectsNonSub2API(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	if _, err := New().ProbeSite(context.Background(), &connector.Channel{SiteURL: srv.URL}); err == nil {
		t.Fatal("expected error")
	}
}

func TestListGroupCatalogMergesAvailableChannels(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/groups/available", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("missing bearer token")
		}
		_, _ = w.Write([]byte(`{"code":0,"data":[
			{"id":1,"name":"claude-pro","platform":"anthropic","rate_multiplier":1.2},
			{"id":2,"name":"codex","platform":"openai","rate_multiplier":0.8,"subscription_type":"subscription"}
		]}`))
	})
	mux.HandleFunc("/api/v1/groups/rates", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"1":0.9}}`))
	})
	mux.HandleFunc("/api/v1/channels/available", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":[{"name":"main","platforms":[
			{"platform":"anthropic","groups":[{"id":1}],"supported_models":[
				{"name":"claude-sonnet-4-5","platform":"anthropic","pricing":{"input_price":0.000003,"output_price":0.000015}}
			]}
		]}]}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	groups, err := New().ListGroupCatalog(context.Background(), &connector.Channel{SiteURL: srv.URL}, &connector.AuthSession{AccessToken: "tok"})
	if err != nil {
		t.Fatalf("ListGroupCatalog: %v", err)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %+v", groups)
	}
	claude := groups[0]
	if claude.Name != "claude-pro" || claude.Ratio != 0.9 || !claude.ModelsKnown || len(claude.Models) != 1 {
		t.Fatalf("claude group = %+v", claude)
	}
	if m := claude.Models[0]; m.InputPerMTok == nil || *m.InputPerMTok < 2.999 || *m.InputPerMTok > 3.001 {
		t.Fatalf("input per mtok = %+v", m.InputPerMTok)
	}
	if codex := groups[1]; codex.ModelsKnown || codex.SubscriptionType != "subscription" {
		t.Fatalf("codex group = %+v", codex)
	}
}
