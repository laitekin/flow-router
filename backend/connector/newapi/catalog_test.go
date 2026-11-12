package newapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bejix/upstream-ops/backend/connector"
)

func TestProbeSiteDetectsNewAPI(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"system_name":"Demo","version":"v0.9","quota_per_unit":500000,"turnstile_check":true,"turnstile_site_key":"0xAAA","linuxdo_oauth":true}}`))
	}))
	defer srv.Close()

	info, err := New().ProbeSite(context.Background(), &connector.Channel{SiteURL: srv.URL})
	if err != nil {
		t.Fatalf("ProbeSite: %v", err)
	}
	if info.Type != connector.TypeNewAPI || info.SiteName != "Demo" || !info.TurnstileEnabled {
		t.Fatalf("unexpected info: %+v", info)
	}
	if len(info.OAuthProviders) != 1 || info.OAuthProviders[0] != "linuxdo" {
		t.Fatalf("oauth providers = %v", info.OAuthProviders)
	}
}

func TestProbeSiteRejectsSub2APIShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"message":"ok","data":{}}`))
	}))
	defer srv.Close()
	if _, err := New().ProbeSite(context.Background(), &connector.Channel{SiteURL: srv.URL}); err == nil {
		t.Fatal("expected error for non-newapi response")
	}
}

func TestListGroupCatalogJoinsGroupsAndPricing(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/self/groups", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("New-Api-User") != "7" {
			t.Errorf("missing New-Api-User header")
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"default":{"ratio":1,"desc":"默认"},"vip":{"ratio":0.5,"desc":"VIP"},"auto":{"ratio":"自动","desc":"auto"}}}`))
	})
	mux.HandleFunc("/api/pricing", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":[
			{"model_name":"gpt-4o","quota_type":0,"model_ratio":1.25,"completion_ratio":4,"enable_groups":["default","vip"]},
			{"model_name":"gpt-image-2","quota_type":1,"model_price":0.04,"enable_groups":["vip"]}
		],"group_ratio":{"default":1,"vip":0.5}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	groups, err := New().ListGroupCatalog(context.Background(), &connector.Channel{SiteURL: srv.URL}, &connector.AuthSession{AccessToken: "t", UserID: "7"})
	if err != nil {
		t.Fatalf("ListGroupCatalog: %v", err)
	}
	if len(groups) != 2 || groups[0].Name != "vip" || groups[1].Name != "default" {
		t.Fatalf("groups should be sorted by ratio: %+v", groups)
	}
	vip := groups[0]
	if !vip.ModelsKnown || len(vip.Models) != 2 {
		t.Fatalf("vip models = %+v", vip.Models)
	}
	if m := vip.Models[0]; m.Name != "gpt-4o" || m.InputPerMTok == nil || *m.InputPerMTok != 2.5 || *m.OutputPerMTok != 10 {
		t.Fatalf("gpt-4o pricing = %+v", m)
	}
	if m := vip.Models[1]; m.PerRequest == nil || *m.PerRequest != 0.04 {
		t.Fatalf("gpt-image-2 pricing = %+v", m)
	}
	if len(groups[1].Models) != 1 {
		t.Fatalf("default models = %+v", groups[1].Models)
	}
}

func TestListGroupCatalogWithoutPricingKeepsGroups(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/user/self/groups", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"data":{"default":{"ratio":1,"desc":""}}}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	groups, err := New().ListGroupCatalog(context.Background(), &connector.Channel{SiteURL: srv.URL}, &connector.AuthSession{AccessToken: "t"})
	if err != nil {
		t.Fatalf("ListGroupCatalog: %v", err)
	}
	if len(groups) != 1 || groups[0].ModelsKnown {
		t.Fatalf("expected one group with unknown models: %+v", groups)
	}
}
