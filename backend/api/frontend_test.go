package api

import (
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func TestFrontendAssetsNeverFallBackToHTML(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":              {Data: []byte("<html>app-shell</html>")},
		"assets/page-AbCd1234.js": {Data: []byte("export default 1")},
	}
	r := gin.New()
	registerFrontend(r, dist)
	for _, tc := range []struct {
		path   string
		status int
		html   bool
	}{
		{"/", 200, true}, {"/gateway", 200, true}, {"/settings", 200, true},
		{"/assets/page-AbCd1234.js", 200, false}, {"/assets/stale-AbCd1234.js", 404, false},
		{"/assets", 301, false}, {"/api", 404, false}, {"/api/unknown", 404, false}, {"/v1/unknown", 404, false},
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.status || strings.Contains(w.Body.String(), "app-shell") != tc.html {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if strings.HasPrefix(tc.path, "/assets") && tc.status == 404 && w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("missing asset is cacheable")
		}
	}
}
