package gateway

import (
	"testing"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestFilterModelRoutesUsesExplicitCatalogRouteIDs(t *testing.T) {
	routes := []storage.GatewayRoute{{ID: 1, Enabled: true}, {ID: 2, Enabled: true}, {ID: 3, Enabled: true}}
	items := []ModelListItem{{
		ID:     "gpt-5.6",
		Source: "catalog",
		Sources: []ModelSource{
			{RouteID: 1},
			{RouteID: 3},
		},
	}}
	filtered := filterRoutesForModel(routes, items, "gpt-5.6")
	if len(filtered) != 2 || filtered[0].ID != 1 || filtered[1].ID != 3 {
		t.Fatalf("unexpected filtered routes: %#v", filtered)
	}
}

func TestFilterModelRoutesKeepsLegacyEntriesUnrestricted(t *testing.T) {
	routes := []storage.GatewayRoute{{ID: 1}, {ID: 2}}
	items := []ModelListItem{{ID: "legacy", Source: "sync", ChannelIDs: []uint{55}}}
	filtered := filterRoutesForModel(routes, items, "legacy")
	if len(filtered) != len(routes) {
		t.Fatalf("legacy model should keep all routes: %#v", filtered)
	}
}

func TestFilterModelRoutesRejectsForeignModel(t *testing.T) {
	routes := []storage.GatewayRoute{{ID: 1}, {ID: 2}}
	items := []ModelListItem{{ID: "gpt-6-sol", Sources: []ModelSource{{RouteID: 1}}}}
	if got := filterRoutesForModel(routes, items, "deepseek-v4-flash"); len(got) != 0 {
		t.Fatalf("foreign model reached GPT routes: %#v", got)
	}
	if got := filterRoutesForModel(routes, items, ""); len(got) != 2 {
		t.Fatalf("model-less job polling was blocked: %#v", got)
	}
	if got := filterRoutesForModel(routes, nil, "legacy"); len(got) != 2 {
		t.Fatalf("uncatalogued legacy group unexpectedly blocked: %#v", got)
	}
}
