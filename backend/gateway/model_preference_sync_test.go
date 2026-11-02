package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bejix/upstream-ops/backend/crypto"
	"github.com/bejix/upstream-ops/backend/storage"
)

func TestChannelSyncPreservesSavedPreferenceAndManualBindings(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"kept"},{"id":"discovered"}]}`))
	}))
	t.Cleanup(server.Close)
	db := openGatewayTestDB(t)
	groups, routes := storage.NewGatewayGroups(db), storage.NewGatewayRoutes(db)
	providers := storage.NewGatewayProviders(db)
	cipher, err := crypto.NewCipher("test-only-model-preference")
	if err != nil {
		t.Fatal(err)
	}
	key, err := cipher.Encrypt("test-only-key")
	if err != nil {
		t.Fatal(err)
	}
	var providerIDs []uint
	for _, name := range []string{"first", "second"} {
		p := &storage.GatewayProvider{Name: name, BaseURL: server.URL, APIKeyCipher: key, Enabled: true, UpstreamProtocol: "openai_chat"}
		if err := providers.Create(p); err != nil {
			t.Fatal(err)
		}
		providerIDs = append(providerIDs, p.ID)
	}
	g := &storage.GatewayGroup{Name: "preference-sync", Status: "active", ModelsMode: "manual"}
	if err := groups.Create(g); err != nil {
		t.Fatal(err)
	}
	if err := routes.SaveForGroup(g.ID, []storage.GatewayRoute{
		{SourceKind: "provider", GatewayProviderID: providerIDs[0], Enabled: true},
		{SourceKind: "provider", GatewayProviderID: providerIDs[1], Enabled: true},
	}); err != nil {
		t.Fatal(err)
	}
	savedRoutes, err := routes.ListByGroupID(g.ID)
	if err != nil {
		t.Fatal(err)
	}
	preferred := savedRoutes[0].ID
	svc := NewService(groups, storage.NewGatewayKeys(db), routes, nil, nil, nil, nil, cipher, nil)
	svc.Providers = providers
	g.ModelsJSON = svc.ModelsJSONString([]ModelListItem{
		{ID: "kept", Source: "custom", PreferredRouteID: preferred, Sources: []ModelSource{{RouteID: preferred}}},
		{ID: "temporarily-absent", Source: "sync", PreferredRouteID: preferred, Sources: []ModelSource{{RouteID: preferred}}},
	})
	if err := groups.Update(g); err != nil {
		t.Fatal(err)
	}
	result, err := svc.SyncGroupModels(context.Background(), g.ID, SyncGroupModelsInput{CustomModels: []ModelListItem{{ID: "kept"}}})
	if err != nil {
		t.Fatal(err)
	}
	items := svc.ParseModelsJSON(result.Group.ModelsJSON)
	byID := make(map[string]ModelListItem)
	for _, item := range items {
		byID[item.ID] = item
	}
	for _, id := range []string{"kept", "temporarily-absent"} {
		item := byID[id]
		if item.PreferredRouteID != preferred || len(item.Sources) != 1 || item.Sources[0].RouteID != preferred {
			t.Fatalf("sync lost or widened %s: %#v", id, item)
		}
	}
	if item := byID["discovered"]; len(item.Sources) != 2 || item.PreferredRouteID != 0 {
		t.Fatalf("new discovery should use its available routes: %#v", item)
	}
	reloaded, err := groups.FindByID(g.ID)
	if err != nil || reloaded.ModelsJSON != result.Group.ModelsJSON {
		t.Fatalf("sync not persisted: %v", err)
	}
}
