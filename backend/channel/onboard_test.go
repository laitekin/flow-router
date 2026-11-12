package channel

import "testing"

func TestNormalizeSiteURL(t *testing.T) {
	cases := map[string]string{
		"example.com":                          "https://example.com",
		"https://example.com/":                 "https://example.com",
		"https://example.com/login?redirect=/": "https://example.com",
		"http://127.0.0.1:3000/console/topup":  "http://127.0.0.1:3000",
		"  https://API.example.com  ":          "https://API.example.com",
	}
	for in, want := range cases {
		got, err := NormalizeSiteURL(in)
		if err != nil || got != want {
			t.Errorf("NormalizeSiteURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://x.com", "https://"} {
		if _, err := NormalizeSiteURL(bad); err == nil {
			t.Errorf("NormalizeSiteURL(%q) should fail", bad)
		}
	}
}

func TestPreviewFingerprintTracksCredentials(t *testing.T) {
	base := CreateInput{Type: "sub2api", SiteURL: "https://a.com", Username: "u", Password: "p"}
	changed := base
	changed.Password = "p2"
	if previewFingerprint(base) == previewFingerprint(changed) {
		t.Fatal("fingerprint must change when password changes")
	}
	trailing := base
	trailing.SiteURL = "https://a.com/"
	if previewFingerprint(base) != previewFingerprint(trailing) {
		t.Fatal("fingerprint should ignore trailing slash")
	}
}
