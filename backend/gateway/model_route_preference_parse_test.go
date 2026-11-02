package gateway

import (
	"testing"

	"github.com/bejix/upstream-ops/backend/storage"
)

func TestServiceModelParsingRetainsPreferredRouteForRuntime(t *testing.T) {
	svc := &Service{}
	raw := "[{\"id\":\"flash\",\"source\":\"custom\",\"preferred_route_id\":31,\"sources\":[{\"route_id\":31},{\"route_id\":32}]}]"
	items := svc.ParseModelsJSON(raw)
	if len(items) != 1 || items[0].PreferredRouteID != 31 {
		t.Fatalf("service parser lost preferred route: %#v", items)
	}
	candidates := []ScoredRoute{
		{Route: storage.GatewayRoute{ID: 32}, EffectiveRate: .15},
		{Route: storage.GatewayRoute{ID: 31}, EffectiveRate: .2},
	}
	got := preferModelRoute(candidates, items, "flash")
	if got[0].Route.ID != 31 {
		t.Fatalf("runtime preference was not applied after parsing: %#v", got)
	}
	again := svc.ParseModelsJSON(svc.ModelsJSONString(items))
	if len(again) != 1 || again[0].PreferredRouteID != 31 {
		t.Fatalf("service encode/decode lost preference: %#v", again)
	}
}
