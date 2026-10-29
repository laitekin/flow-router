package gateway

import (
	"github.com/bejix/upstream-ops/backend/storage"
	"testing"
)

func TestContextAffinityScopesAndPersistence(t *testing.T) {
	db := openGatewayTestDB(t)
	r := storage.NewGatewayRoutes(db)
	out := contextReferences([]byte(`{"response":{"id":"resp_a","output":[{"encrypted_content":"secret-blob"}]}}`), true)
	if len(out) != 2 {
		t.Fatalf("want two refs, got %v", out)
	}
	if err := r.RememberContextRoute(1, 2, 3, out); err != nil {
		t.Fatal(err)
	}
	input := contextReferences([]byte(`{"previous_response_id":"resp_a","input":[{"encrypted_content":"secret-blob"}]}`), false)
	// New repository instance represents a new runtime reading durable state.
	r = storage.NewGatewayRoutes(db)
	got, err := r.ResolveContextRoute(1, 2, input)
	if err != nil || got != 3 {
		t.Fatalf("route=%d err=%v", got, err)
	}
	got, err = r.ResolveContextRoute(9, 2, input)
	if err != nil || got != 0 {
		t.Fatal("affinity leaked across API keys")
	}
	other := contextReferences([]byte(`{"id":"resp_b"}`), true)
	if err := r.RememberContextRoute(1, 2, 4, other); err != nil {
		t.Fatal(err)
	}
	_, err = r.ResolveContextRoute(1, 2, append(input, other...))
	if err == nil {
		t.Fatal("mixed-provider context was accepted")
	}
	if refs := contextReferences([]byte(`{"input":"ordinary prompt"}`), false); len(refs) != 0 {
		t.Fatal("stateless request was pinned")
	}
}
