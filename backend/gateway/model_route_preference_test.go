package gateway

import (
	"encoding/json"
	"testing"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestPreferredModelRouteOverridesOrderWithoutChangingBilling(t *testing.T) {
	candidates := []ScoredRoute{
		{Route: storage.GatewayRoute{ID: 32}, EffectiveRate: .15, BillingRate: .15},
		{Route: storage.GatewayRoute{ID: 31}, EffectiveRate: .2, BillingRate: .2},
		{Route: storage.GatewayRoute{ID: 45}, EffectiveRate: .25, BillingRate: .25},
	}
	items := []ModelListItem{{ID: "flash", PreferredRouteID: 31}}
	got := preferModelRoute(candidates, items, "flash")
	if got[0].Route.ID != 31 || got[1].Route.ID != 32 || got[2].Route.ID != 45 {
		t.Fatalf("unexpected priority order: %#v", got)
	}
	if got[0].BillingRate != .2 || got[1].BillingRate != .15 {
		t.Fatal("preference changed billing")
	}
}
func TestPreferredModelRouteKeepsFallbackAndContextConstraints(t *testing.T) {
	for _, name := range []string{"preferred-cooled-down", "preferred-excluded", "different-context-route"} {
		t.Run(name, func(t *testing.T) {
			got := preferModelRoute([]ScoredRoute{{Route: storage.GatewayRoute{ID: 32}}}, []ModelListItem{{ID: "flash", PreferredRouteID: 31}}, "flash")
			if len(got) != 1 || got[0].Route.ID != 32 {
				t.Fatalf("unavailable preference blocked fallback: %#v", got)
			}
		})
	}
}
func TestPreferredModelRoutePreservesLegacyAndOtherModels(t *testing.T) {
	for _, item := range []ModelListItem{{ID: "flash"}, {ID: "other", PreferredRouteID: 31}} {
		got := preferModelRoute([]ScoredRoute{{Route: storage.GatewayRoute{ID: 32}}, {Route: storage.GatewayRoute{ID: 31}}}, []ModelListItem{item}, "flash")
		if got[0].Route.ID != 32 || got[1].Route.ID != 31 {
			t.Fatal("legacy ordering changed")
		}
	}
}
func TestPreferredModelRouteJSONRoundTrip(t *testing.T) {
	var items []ModelListItem
	if err := json.Unmarshal([]byte("[{\"id\":\"flash\",\"preferred_route_id\":31}]"), &items); err != nil {
		t.Fatal(err)
	}
	if items[0].PreferredRouteID != 31 {
		t.Fatal("preference not decoded")
	}
	data, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	var again []ModelListItem
	if err := json.Unmarshal(data, &again); err != nil || again[0].PreferredRouteID != 31 {
		t.Fatalf("preference lost: %s", data)
	}
}
func TestCatalogSyncRetainsOnlyStillBoundPreference(t *testing.T) {
	old := []ModelListItem{{ID: "flash", PreferredRouteID: 31}}
	kept := mergeCatalogModels(old, []CatalogModel{{ID: "flash"}}, []ModelSource{{RouteID: 31}, {RouteID: 32}})
	if kept[0].PreferredRouteID != 31 {
		t.Fatal("bound preference lost")
	}
	removed := mergeCatalogModels(old, []CatalogModel{{ID: "flash"}}, []ModelSource{{RouteID: 32}})
	if removed[0].PreferredRouteID != 0 {
		t.Fatal("removed preference retained")
	}
}
