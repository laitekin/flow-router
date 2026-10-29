package gateway

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
)

// contextReferences returns bounded, namespaced hashes of stateful references.
// Provider-specific encrypted reasoning must not be replayed to another provider.
func contextReferences(body []byte, output bool) []string {
	var root any
	if json.Unmarshal(body, &root) != nil {
		return nil
	}
	seen := map[string]bool{}
	refs := []string{}
	add := func(kind, value string) {
		if value == "" || len(refs) >= 128 {
			return
		}
		h := sha256.Sum256([]byte(kind + ":" + value))
		key := hex.EncodeToString(h[:])
		if !seen[key] {
			seen[key] = true
			refs = append(refs, key)
		}
	}
	var walk func(any)
	walk = func(v any) {
		if len(refs) >= 128 {
			return
		}
		switch x := v.(type) {
		case map[string]any:
			for k, item := range x {
				if s, ok := item.(string); ok {
					switch {
					case k == "encrypted_content":
						add("encrypted", s)
					case !output && k == "previous_response_id":
						add("response", s)
					case output && k == "id" && strings.HasPrefix(s, "resp_"):
						add("response", s)
					}
				}
				walk(item)
			}
		case []any:
			for _, item := range x {
				walk(item)
			}
		}
	}
	walk(root)
	return refs
}

func (rt *Runtime) captureContext(c *gin.Context, body []byte) {
	keyID := c.GetUint("context_key_id")
	groupID := c.GetUint("context_group_id")
	routeID := c.GetUint("context_route_id")
	if keyID == 0 || groupID == 0 || routeID == 0 || rt.Routes == nil {
		return
	}
	if err := rt.Routes.RememberContextRoute(keyID, groupID, routeID, contextReferences(body, true)); err != nil && rt.Log != nil {
		rt.Log.Warn("save upstream context affinity failed", "route_id", routeID, "err", err)
	}
}
