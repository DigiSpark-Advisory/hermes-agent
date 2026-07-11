"""Server-rendered /login page — DigiSpark Advisory skin (v1.2).

No React, no framework dependency. Listed providers come from the
registry; OAuth providers render as buttons linking to
``/auth/login?provider=<name>``; password providers render a credential
form (wired by a small inline script to POST ``/auth/password-login``).

Visual styling is the DigiSpark design system (ported from the desktop
tokens): light theme by default — canvas ``#f8faff``, card ``#ffffff``,
text ``#17171a``, brand blue ``#0053fd`` — with a dark variant via
``prefers-color-scheme: dark`` (canvas ``#121419``, card ``#1d2029``,
accent lifted to ``#4d7fff`` for contrast). System font stack; no
``/fonts`` dependency, so the page renders even without the SPA bundle.

Password forms carry a default-checked **Remember me** checkbox. Checked
→ persistent cookies (30-day rolling session); unchecked → browser-
session cookies that die on close (see ``cookies.set_session_cookies``
``persistent=`` and ``routes.auth_password_login``).

Test-stable class names: the existing test suite extracts the
``class="provider-btn"`` anchor href to walk the OAuth flow. That
class name MUST NOT change without updating
``tests/hermes_cli/test_dashboard_auth_401_reauth.py``.
"""
from __future__ import annotations

import html

from hermes_cli.dashboard_auth import list_session_providers

# Inline CSS only — the login page must not depend on the SPA build being
# present or on the injected session token. The template uses literal
# ``__PLACEHOLDER__`` markers substituted with ``str.replace`` (NOT
# ``str.format``), so CSS braces stay single and un-escaped.
_LOGIN_HTML_TEMPLATE = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign in — DigiSpark Analyst</title>
<style>
  :root {
    --canvas: #f8faff;
    --card: #ffffff;
    --text: #17171a;
    --text-2: #5c6270;
    --text-3: #9aa0ae;
    --accent: #0053fd;
    --accent-soft: rgba(0, 83, 253, 0.08);
    --green: #1f8a65;
    --hairline: rgba(23, 23, 26, 0.08);
    --hairline-strong: rgba(23, 23, 26, 0.16);
    --shadow: 0 1px 2px rgba(23, 23, 26, 0.04), 0 8px 24px rgba(23, 23, 26, 0.06);
    --radius: 0.45rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #121419;
      --card: #1d2029;
      --text: #e8eaf1;
      --text-2: #9ba1b0;
      --text-3: #666c7a;
      --accent: #4d7fff;
      --accent-soft: rgba(77, 127, 255, 0.12);
      --green: #34a37d;
      --hairline: rgba(232, 234, 241, 0.08);
      --hairline-strong: rgba(232, 234, 241, 0.16);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
    }
  }

  *, *::before, *::after { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    background: var(--canvas);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Soft brand glow at the top of the canvas. */
  body {
    background-image: radial-gradient(
      ellipse 420px 260px at 50% -8%,
      var(--accent-soft),
      transparent 70%
    );
    background-attachment: fixed;
    display: grid;
    place-items: center;
    padding: clamp(1.5rem, 6vh, 6rem) 1.25rem;
  }

  main {
    width: 100%;
    max-width: 23rem;
    animation: rise 0.5s ease-out both;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    main { animation: none; }
  }

  .card {
    background: var(--card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 2rem 2rem 1.6rem;
  }

  .brand-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .spark {
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: 7px;
    background: linear-gradient(135deg, var(--accent) 0%, #3d78ff 100%);
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wordmark {
    font-size: 1.06rem;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  .wordmark .adv {
    color: var(--text-3);
    font-weight: 500;
  }
  .subtitle {
    margin: 0.15rem 0 1.5rem 2.25rem;
    color: var(--text-2);
    font-size: 0.78rem;
  }

  .provider-list {
    display: grid;
    gap: 0.75rem;
  }

  /* Provider button — brand-blue primary; shared by OAuth anchors and the
     password form's submit. Class name is test-load-bearing. */
  .provider-btn {
    display: block;
    width: 100%;
    padding: 0.7rem 1rem;
    text-align: center;
    background: var(--accent);
    color: #fff;
    font-family: inherit;
    font-weight: 600;
    font-size: 0.85rem;
    text-decoration: none;
    border: 0;
    border-radius: calc(var(--radius) - 2px);
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 83, 253, 0.25);
    transition: filter 0.12s ease-out;
  }
  .provider-btn:hover { filter: brightness(1.08); }
  .provider-btn:active { filter: brightness(0.92); }
  .provider-btn:disabled { opacity: 0.55; cursor: default; }
  .provider-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }

  .provider-form {
    display: grid;
    gap: 0.85rem;
    text-align: left;
  }
  .form-title {
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .field { display: grid; gap: 0.35rem; }
  .field-label {
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .field-input {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: var(--canvas);
    color: var(--text);
    border: 1px solid var(--hairline-strong);
    border-radius: calc(var(--radius) - 2px);
    font-family: inherit;
    font-size: 0.9rem;
  }
  .field-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .remember {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    cursor: pointer;
    margin-top: 0.1rem;
  }
  .remember input[type="checkbox"] {
    width: 1rem;
    height: 1rem;
    margin: 0.1rem 0 0;
    flex: none;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .remember-text {
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .remember-hint {
    display: block;
    font-size: 0.7rem;
    color: var(--text-3);
    margin-top: 0.05rem;
  }

  .form-error {
    color: #cf2d56;
    font-size: 0.8rem;
  }

  footer {
    margin-top: 1.4rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    color: var(--text-3);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.66rem;
    letter-spacing: 0.04em;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--green);
  }

  ::selection { background: var(--accent); color: #fff; }
</style>
</head>
<body>
<main>
  <div class="card">
    <div class="brand-row">
      <div class="spark">◆</div>
      <div class="wordmark">DigiSpark <span class="adv">Advisory</span></div>
    </div>
    <p class="subtitle">Analyst workspace &middot; private gateway</p>
    <div class="provider-list">
__PROVIDER_BUTTONS__
    </div>
  </div>
  <footer><span class="dot"></span>private gateway &middot; authentication required</footer>
</main>
__PASSWORD_SCRIPT__
</body>
</html>
"""

_EMPTY_HTML = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Sign-in unavailable — DigiSpark Analyst</title>
<style>
  :root {
    --canvas: #f8faff; --card: #ffffff; --text: #17171a;
    --accent: #0053fd; --hairline: rgba(23, 23, 26, 0.08);
    --shadow: 0 1px 2px rgba(23,23,26,0.04), 0 8px 24px rgba(23,23,26,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #121419; --card: #1d2029; --text: #e8eaf1;
      --accent: #4d7fff; --hairline: rgba(232, 234, 241, 0.08);
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; min-height: 100%;
    background: var(--canvas); color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 16px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  body {
    display: grid; place-items: center;
    padding: clamp(1.5rem, 6vh, 6rem) 1.25rem;
  }
  main {
    width: 100%; max-width: 32rem;
    padding: 2rem;
    background: var(--card);
    border: 1px solid var(--hairline);
    border-radius: 0.45rem;
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0 0 1rem;
    font-size: 1.25rem; font-weight: 700;
    color: var(--accent);
  }
  p { margin: 0 0 1rem; }
  code {
    background: rgba(127, 127, 127, 0.15);
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
  }
</style>
</head>
<body>
<main>
<h1>Sign-in unavailable</h1>
<p>This dashboard is bound to a non-loopback host but no authentication
providers are installed.</p>
<p>Install <code>plugins/dashboard-auth-nous</code> (default) or another
auth provider, or restart with <code>--insecure</code> to bypass the
auth gate (not recommended on untrusted networks).</p>
</main>
</body>
</html>
"""


# Inline script that wires every password provider form to POST JSON to
# ``/auth/password-login`` and navigate on success. Emitted ONLY when at
# least one ``supports_password`` provider is listed (OAuth-only login
# pages stay script-free, preserving the no-JS contract for that case).
#
# Plain string (never run through ``str.format``), so braces are literal.
# A single delegated submit handler covers all forms; the provider name is
# read from the form's ``data-provider`` attribute. The ``remember``
# checkbox state rides along — absent checkbox defaults to true (OAuth
# semantics preserved for any password provider form rendered without it).
_PASSWORD_FORM_SCRIPT = """\
<script>
(function () {
  function handle(form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = form.querySelector('.form-error');
      var btn = form.querySelector('button[type=submit]');
      if (err) { err.hidden = true; err.textContent = ''; }
      if (btn) { btn.disabled = true; }
      var rememberEl = form.querySelector('input[name=remember]');
      var body = {
        provider: form.getAttribute('data-provider') || '',
        username: (form.querySelector('input[name=username]') || {}).value || '',
        password: (form.querySelector('input[name=password]') || {}).value || '',
        remember: rememberEl ? !!rememberEl.checked : true,
        next: (form.querySelector('input[name=next]') || {}).value || ''
      };
      fetch('/auth/password-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin'
      }).then(function (resp) {
        if (resp.ok) {
          return resp.json().then(function (data) {
            window.location.assign((data && data.next) || '/');
          });
        }
        var msg = resp.status === 429
          ? 'Too many attempts. Please wait and try again.'
          : (resp.status === 401 ? 'Invalid username or password.'
                                 : 'Sign-in failed. Please try again.');
        if (err) { err.textContent = msg; err.hidden = false; }
        if (btn) { btn.disabled = false; }
      }).catch(function () {
        if (err) { err.textContent = 'Network error. Please try again.'; err.hidden = false; }
        if (btn) { btn.disabled = false; }
      });
    });
  }
  var forms = document.querySelectorAll('form.provider-form');
  for (var i = 0; i < forms.length; i++) { handle(forms[i]); }
})();
</script>
"""


def render_login_html(*, next_path: str = "") -> str:
    """Return the full HTML for ``GET /login``.

    ``next_path`` — when set, the post-login landing path the user
    originally requested. Threaded into each provider button's ``href``
    as a ``next=`` query parameter so the OAuth round trip carries it
    end-to-end. The caller (``routes.login_page``) is responsible for
    validating ``next_path`` against the same-origin rules before we
    emit it; we still HTML-escape it as defence in depth.
    """
    providers = list_session_providers()
    if not providers:
        return _EMPTY_HTML

    if next_path:
        # URL-encode then HTML-escape. The URL-encode step matches the
        # gate's ``_safe_next_target`` output shape (also URL-encoded),
        # so a value that round-tripped from /login?next=... back into
        # the button href is byte-identical.
        from urllib.parse import quote
        next_qs = f"&next={html.escape(quote(next_path, safe=''), quote=True)}"
    else:
        next_qs = ""

    buttons = []
    needs_password_script = False
    for p in providers:
        if getattr(p, "supports_password", False):
            needs_password_script = True
            buttons.append(_render_password_form(p, next_path))
        else:
            buttons.append(
                f'      <a class="provider-btn" '
                f'href="/auth/login?provider={html.escape(p.name, quote=True)}{next_qs}">'
                f'Sign in with {html.escape(p.display_name)}</a>'
            )
    script = _PASSWORD_FORM_SCRIPT if needs_password_script else ""
    return (
        _LOGIN_HTML_TEMPLATE
        .replace("__PROVIDER_BUTTONS__", "\n".join(buttons))
        .replace("__PASSWORD_SCRIPT__", script)
    )


def _render_password_form(provider, next_path: str) -> str:
    """Render a username/password form for a ``supports_password`` provider.

    The form is wired by :data:`_PASSWORD_FORM_SCRIPT` (a single delegated
    submit handler) to POST JSON to ``/auth/password-login`` and navigate
    on success. ``next_path`` is carried in a hidden field; it has already
    been validated same-origin by the caller and is HTML-escaped here as
    defence in depth. The provider ``name`` is emitted in a ``data-``
    attribute (not a hidden input) so the script reads it without trusting
    form-field ordering. The default-checked ``remember`` checkbox selects
    persistent vs browser-session cookies (see ``cookies.py``).
    """
    pname = html.escape(provider.name, quote=True)
    plabel = html.escape(provider.display_name)
    safe_next = html.escape(next_path, quote=True) if next_path else ""
    return (
        f'      <form class="provider-form" data-provider="{pname}" '
        f'autocomplete="on">\n'
        f'        <div class="form-title">Sign in with {plabel}</div>\n'
        f'        <input type="hidden" name="next" value="{safe_next}">\n'
        f'        <label class="field">\n'
        f'          <span class="field-label">Username</span>\n'
        f'          <input class="field-input" type="text" name="username" '
        f'autocomplete="username" autocapitalize="none" '
        f'autocorrect="off" spellcheck="false" required>\n'
        f'        </label>\n'
        f'        <label class="field">\n'
        f'          <span class="field-label">Password</span>\n'
        f'          <input class="field-input" type="password" name="password" '
        f'autocomplete="current-password" required>\n'
        f'        </label>\n'
        f'        <label class="remember">\n'
        f'          <input type="checkbox" name="remember" checked>\n'
        f'          <span class="remember-text">Remember me\n'
        f'            <span class="remember-hint">Stay signed in on this '
        f'device for 30 days</span>\n'
        f'          </span>\n'
        f'        </label>\n'
        f'        <div class="form-error" role="alert" hidden></div>\n'
        f'        <button class="provider-btn" type="submit">Sign in</button>\n'
        f'      </form>'
    )
