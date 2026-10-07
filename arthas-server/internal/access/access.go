// Package access implements an optional instance-wide passphrase gate.
//
// Arthas is zero-knowledge by design: the server relays ciphertext and never
// learns a room key. This package does not change that in either direction.
// It is purely an access-control layer in front of the HTTP surface, so a
// self-hosted deployment can stop strangers from using the instance at all —
// creating rooms, consuming memory and bandwidth — rather than merely stopping
// them from reading messages (which encryption already handles).
//
// The gate is inert unless ACCESS_PASSPHRASE is set, so public deployments and
// local development are unaffected by its presence.
package access

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/arthas/arthas-server/internal/hub"
	"github.com/arthas/arthas-server/internal/logger"
)

const (
	// CookieName holds the signed access token.
	CookieName = "arthas_access"

	// tokenVersion prefixes every token so the format can change later without
	// silently accepting tokens minted under different rules.
	tokenVersion = "v1"

	// pingPath must never be gated — see Middleware.
	pingPath = "/ping"

	// gatePath receives the passphrase submission.
	gatePath = "/gate"

	defaultTTL = 30 * 24 * time.Hour
)

// Gate enforces a shared passphrase across the whole HTTP surface.
//
// A nil *Gate is a valid, disabled gate: every method is a no-op, so callers
// can wire it unconditionally without branching.
type Gate struct {
	key        []byte
	passphrase string
	ttl        time.Duration
	limiter    *hub.RateLimiter
}

// New returns a Gate for the given passphrase, or nil when passphrase is empty
// (the gate is then disabled). A ttl of zero selects defaultTTL.
func New(passphrase string, ttl time.Duration) *Gate {
	if passphrase == "" {
		return nil
	}
	if ttl <= 0 {
		ttl = defaultTTL
	}
	return &Gate{
		key:        deriveKey(passphrase),
		passphrase: passphrase,
		ttl:        ttl,
		// The submission endpoint is the only brute-forceable surface, so it is
		// rate limited per IP. Reuses the limiter already in internal/hub.
		limiter: hub.NewRateLimiter(10, time.Minute),
	}
}

// Enabled reports whether the gate will actually challenge requests.
func (g *Gate) Enabled() bool { return g != nil }

// Middleware wraps h, requiring a valid access cookie on every request.
//
// Two paths are deliberately exempt:
//
//   - /ping, because platform health checks send no cookie. Gating it makes
//     every check fail, the orchestrator marks the machine unhealthy, and the
//     deployment restart-loops itself into an outage.
//   - /gate, which is how a caller obtains a cookie in the first place.
func (g *Gate) Middleware(h http.Handler) http.Handler {
	if g == nil {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case pingPath:
			h.ServeHTTP(w, r)
			return
		case gatePath:
			g.handleSubmit(w, r)
			return
		}

		// Browsers attach cookies to same-origin WebSocket upgrades, so this
		// check covers /ws as well as ordinary requests. The cookie is read
		// before the handler runs, so an unauthenticated upgrade never happens.
		if c, err := r.Cookie(CookieName); err == nil && valid(c.Value, g.key, time.Now()) {
			h.ServeHTTP(w, r)
			return
		}
		g.serveChallenge(w)
	})
}

// handleSubmit validates a passphrase and issues the cookie on success.
func (g *Gate) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		g.serveChallenge(w)
		return
	}
	ip := clientIP(r)
	if !g.limiter.Allow(ip) {
		http.Error(w, "too many attempts", http.StatusTooManyRequests)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// ConstantTimeCompare, never ==: a short-circuiting comparison leaks the
	// passphrase one byte at a time through response timing.
	if subtle.ConstantTimeCompare([]byte(r.PostFormValue("passphrase")), []byte(g.passphrase)) != 1 {
		logger.Warn("Access", "rejected passphrase attempt from %s", ip)
		http.Error(w, "invalid passphrase", http.StatusUnauthorized)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    mint(g.key, time.Now().Add(g.ttl)),
		Path:     "/",
		MaxAge:   int(g.ttl.Seconds()),
		HttpOnly: true, // unreadable from JS, so an XSS bug cannot exfiltrate it
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode, // still sent on the same-origin /ws upgrade
	})
	w.WriteHeader(http.StatusNoContent)
}

// serveChallenge renders the passphrase page.
//
// It responds 200 at the originally requested URL instead of redirecting.
// Share links are hash routes (/#/join/<code>) and the fragment is never sent
// to the server, so a redirect would silently discard the invite and drop the
// user into an empty app. Rendering in place leaves the fragment untouched in
// the address bar, and the page reloads into the SPA once authenticated.
func (g *Gate) serveChallenge(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(challengePage))
}

// deriveKey turns the passphrase into the HMAC signing key.
//
// Deriving the key from the passphrase rather than from an independent secret
// makes rotation self-enforcing: changing ACCESS_PASSPHRASE changes the key,
// which invalidates every outstanding cookie. Rotating the secret is therefore
// also the "sign everyone out" button.
func deriveKey(passphrase string) []byte {
	sum := sha256.Sum256([]byte(passphrase))
	return sum[:]
}

// mint builds a signed token valid until expiry.
// Format: v1.<base64(unix expiry)>.<base64(HMAC-SHA256)>
func mint(key []byte, expiry time.Time) string {
	payload := tokenVersion + "." + base64.RawURLEncoding.EncodeToString(
		[]byte(strconv.FormatInt(expiry.Unix(), 10)))
	return payload + "." + base64.RawURLEncoding.EncodeToString(sign(key, payload))
}

func sign(key []byte, payload string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(payload))
	return m.Sum(nil)
}

// valid reports whether token carries an intact signature and has not expired.
//
// Everything needed to verify a token lives inside the token, so the server
// keeps no session table. That matters here: this server holds all state in
// memory, and a stateless token means a restart or redeploy does not sign the
// whole household out.
func valid(token string, key []byte, now time.Time) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != tokenVersion {
		return false
	}
	gotMAC, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	// hmac.Equal is constant time. Verify the signature before trusting any
	// other field, so expiry is only read off a payload we know is ours.
	if !hmac.Equal(gotMAC, sign(key, parts[0]+"."+parts[1])) {
		return false
	}
	rawExp, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	exp, err := strconv.ParseInt(string(rawExp), 10, 64)
	if err != nil {
		return false
	}
	return now.Unix() < exp
}

// isHTTPS reports whether the original client request used TLS.
//
// Behind a terminating proxy (fly.io, Caddy) r.TLS is nil even though the user
// is on HTTPS, so the forwarded header is authoritative. Getting this wrong in
// the lenient direction would mark the cookie Secure over plain HTTP and the
// browser would silently drop it, making local development impossible.
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// clientIP extracts the caller's address, preferring the proxy header.
func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		if first, _, found := strings.Cut(fwd, ","); found {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(fwd)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
