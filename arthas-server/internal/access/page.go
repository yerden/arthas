package access

// challengePage is the passphrase prompt shown to unauthenticated callers.
//
// It is intentionally self-contained: no external stylesheet, font or script.
// The page is served in place of any gated URL, including asset requests, so
// it cannot rely on anything else loading successfully.
//
// On success the handler returns 204 and the page calls location.reload(),
// which re-requests the same URL — fragment and all — now carrying the cookie.
// That is what preserves a /#/join/<code> invite across authentication.
const challengePage = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Arthas</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex;
    align-items: center; justify-content: center; padding: 1rem;
    background: #111827; color: #f9fafb;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .card {
    width: 100%; max-width: 22rem; background: #1f2937;
    border-radius: 1rem; padding: 2rem; box-shadow: 0 25px 50px -12px rgba(0,0,0,.5);
  }
  .logo { font-size: 2.25rem; text-align: center; }
  h1 { margin: .5rem 0 .25rem; font-size: 1.25rem; text-align: center; }
  p.sub { margin: 0 0 1.5rem; font-size: .875rem; color: #9ca3af; text-align: center; }
  label { display: block; font-size: .875rem; color: #d1d5db; margin-bottom: .5rem; }
  input {
    width: 100%; padding: .625rem .75rem; font-size: 1rem;
    background: #374151; color: #fff;
    border: 1px solid #4b5563; border-radius: .5rem;
  }
  input:focus { outline: none; border-color: #6366f1; }
  button {
    width: 100%; margin-top: 1rem; padding: .75rem; min-height: 44px;
    font-size: 1rem; font-weight: 500; color: #fff; background: #4f46e5;
    border: 0; border-radius: .5rem; cursor: pointer;
  }
  button:hover { background: #6366f1; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .err { margin-top: .75rem; font-size: .875rem; color: #f87171; min-height: 1.25rem; }
</style>
</head>
<body>
  <main class="card">
    <div class="logo" aria-hidden="true">&#128274;</div>
    <h1>Arthas</h1>
    <p class="sub">This is a private instance.</p>
    <form id="f">
      <label for="p">Passphrase</label>
      <input id="p" name="passphrase" type="password" autocomplete="current-password"
             autofocus required>
      <button id="b" type="submit">Unlock</button>
      <div class="err" id="e" role="alert" aria-live="polite"></div>
    </form>
  </main>
<script>
(function () {
  var f = document.getElementById('f'), p = document.getElementById('p'),
      b = document.getElementById('b'), e = document.getElementById('e');
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    e.textContent = ''; b.disabled = true;
    fetch('/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ passphrase: p.value })
    }).then(function (res) {
      if (res.ok) { location.reload(); return; }
      b.disabled = false;
      e.textContent = res.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : 'Incorrect passphrase.';
      p.select();
    }).catch(function () {
      b.disabled = false;
      e.textContent = 'Network error. Try again.';
    });
  });
})();
</script>
</body>
</html>`
