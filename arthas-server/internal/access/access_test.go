package access

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testPass = "correct horse battery staple"

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("passed"))
	})
}

// ─── Token ───────────────────────────────────────────────────────────────────

func TestTokenRoundTrip(t *testing.T) {
	key := deriveKey(testPass)
	now := time.Now()
	tok := mint(key, now.Add(time.Hour))

	if !valid(tok, key, now) {
		t.Fatal("freshly minted token should be valid")
	}
}

func TestTokenRejects(t *testing.T) {
	key := deriveKey(testPass)
	now := time.Now()

	tests := []struct {
		name  string
		token string
		key   []byte
	}{
		{"expired", mint(key, now.Add(-time.Second)), key},
		{"tampered signature", mint(key, now.Add(time.Hour)) + "x", key},
		{"rotated passphrase", mint(key, now.Add(time.Hour)), deriveKey("different")},
		{"wrong version", "v2" + strings.TrimPrefix(mint(key, now.Add(time.Hour)), "v1"), key},
		{"malformed", "not-a-token", key},
		{"empty", "", key},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if valid(tc.token, tc.key, now) {
				t.Error("token should have been rejected")
			}
		})
	}
}

// TestTokenForgeryNeedsKey guards the core property: the expiry is signed, so a
// client cannot extend its own session by editing the payload.
func TestTokenForgeryNeedsKey(t *testing.T) {
	key := deriveKey(testPass)
	now := time.Now()
	expired := mint(key, now.Add(-time.Hour))

	parts := strings.Split(expired, ".")
	forged := parts[0] + "." + strings.Split(mint(key, now.Add(time.Hour)), ".")[1] + "." + parts[2]

	if valid(forged, key, now) {
		t.Fatal("payload swap must invalidate the signature")
	}
}

// ─── Middleware ──────────────────────────────────────────────────────────────

func TestNilGateIsDisabled(t *testing.T) {
	g := New("", 0)
	if g.Enabled() {
		t.Fatal("empty passphrase must leave the gate disabled")
	}

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "passed" {
		t.Fatalf("disabled gate must pass through, got %d %q", rec.Code, rec.Body.String())
	}
}

// TestPingIsNeverGated covers the failure mode that takes the deployment down:
// a gated /ping fails every platform health check, and the orchestrator
// restart-loops the machine.
func TestPingIsNeverGated(t *testing.T) {
	g := New(testPass, 0)

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ping", nil))

	if rec.Code != http.StatusOK || rec.Body.String() != "passed" {
		t.Fatalf("/ping must bypass the gate, got %d %q", rec.Code, rec.Body.String())
	}
}

// TestChallengeIsNotARedirect pins the behaviour that keeps /#/join/<code>
// invites intact: the challenge renders in place at the requested URL.
func TestChallengeIsNotARedirect(t *testing.T) {
	g := New(testPass, 0)

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("challenge must be 200, not a redirect, got %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "Passphrase") {
		t.Fatalf("expected the challenge page, got %q", body)
	}
	if rec.Header().Get("Location") != "" {
		t.Error("challenge must not set Location")
	}
}

func TestValidCookiePasses(t *testing.T) {
	g := New(testPass, 0)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: mint(g.key, time.Now().Add(time.Hour))})

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK || rec.Body.String() != "passed" {
		t.Fatalf("valid cookie should reach the handler, got %d %q", rec.Code, rec.Body.String())
	}
}

func TestExpiredCookieIsChallenged(t *testing.T) {
	g := New(testPass, 0)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: mint(g.key, time.Now().Add(-time.Hour))})

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, req)

	if rec.Body.String() == "passed" {
		t.Fatal("expired cookie must not reach the handler")
	}
}

// ─── Submission ──────────────────────────────────────────────────────────────

func submit(g *Gate, pass, ip string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/gate",
		strings.NewReader(url.Values{"passphrase": {pass}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Forwarded-For", ip)

	rec := httptest.NewRecorder()
	g.Middleware(okHandler()).ServeHTTP(rec, req)
	return rec
}

func TestSubmitCorrectPassphraseSetsCookie(t *testing.T) {
	g := New(testPass, 0)
	rec := submit(g, testPass, "203.0.113.1")

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName {
		t.Fatalf("expected an access cookie, got %+v", cookies)
	}
	c := cookies[0]
	if !c.HttpOnly {
		t.Error("cookie must be HttpOnly so XSS cannot read it")
	}
	if c.SameSite != http.SameSiteLaxMode {
		t.Error("cookie must be SameSite=Lax so it rides the same-origin /ws upgrade")
	}
	if !valid(c.Value, g.key, time.Now()) {
		t.Error("issued cookie must carry a valid token")
	}
}

func TestSubmitWrongPassphraseRejected(t *testing.T) {
	g := New(testPass, 0)
	rec := submit(g, "guess", "203.0.113.2")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Error("no cookie may be issued on failure")
	}
}

// TestSubmitIsRateLimited ensures the one brute-forceable surface is bounded.
func TestSubmitIsRateLimited(t *testing.T) {
	g := New(testPass, 0)
	const ip = "203.0.113.3"

	var limited bool
	for i := 0; i < 20; i++ {
		if submit(g, "guess", ip).Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("repeated wrong guesses from one IP must eventually be rate limited")
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func TestIsHTTPSHonoursForwardedProto(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if isHTTPS(req) {
		t.Error("plain request is not HTTPS")
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	if !isHTTPS(req) {
		t.Error("terminating proxies report TLS via X-Forwarded-Proto")
	}
}

func TestClientIPPrefersForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:5000"
	if got := clientIP(req); got != "10.0.0.1" {
		t.Errorf("RemoteAddr fallback = %q, want 10.0.0.1", got)
	}
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := clientIP(req); got != "203.0.113.9" {
		t.Errorf("forwarded client = %q, want 203.0.113.9", got)
	}
}
