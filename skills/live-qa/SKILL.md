---
name: live-qa
description: Run a step-by-step live QA pass on a real website or running app in a real browser — navigate, click, fill, assert, capture a numbered screenshot per step, and report a pass/fail table with console errors, failed requests, and accessibility findings. Use when the user says test my site/app live, walk through a flow on the real website, do manual QA with screenshots, reproduce a bug in the browser, or verify a deploy on prod/staging.
allowed-tools:
  - Bash
  - Read
  - Write
license: MIT
permissions:
  - env
  - network
---

# Live QA in a real browser

Drive a real browser one user-visible step at a time, saving evidence per step. The
output is a pass/fail table plus screenshots, not a test file. For a committed,
re-runnable suite see `references/promoting-to-a-spec.md`.

Works in any agent that can run a shell command: the driving tool is a Node script
that owns its own Chromium, so no agent-specific browser tool is required.

**Not for:** a committed, re-runnable test suite — this is a one-off evidence run; promote a green run to a Playwright spec via `references/promoting-to-a-spec.md`. A site that blocks local browsers belongs to `cloud-browser`.

## Portability

Works in any agent that can run shell commands (pi, Claude Code, Codex, Cursor,
Gemini CLI, …): the instructions are plain Markdown and the helper is a stdlib
script. Commands use `$SKILL_DIR` for this skill's own directory — the folder that
holds this `SKILL.md`. Set it once per session, for example:

```bash
SKILL_DIR=~/.claude/skills/live-qa     # or ~/.codex/skills/…, ~/.pi/agent/skills/…, .cursor/skills/…
```

## 1. Pick a lane (both are fine, one is always available)

| Lane | Use when | How |
| --- | --- | --- |
| **`scripts/drive.mjs`** (default) | any agent, any machine | Node 18+ and Playwright; see prerequisites below |
| Native browser tool | your agent has one (pi's `agent_browser`, a Playwright/Chrome-DevTools MCP server, Cursor's browser) | use its own verbs; `references/browser-lanes.md` maps them one-to-one |

**Prerequisites for the default lane**

```bash
node -v                       # 18+
npm i -D playwright           # once per project (or: npm i -g playwright)
npx playwright install chromium   # skipped automatically if Google Chrome is installed
```

`drive.mjs` prefers the real Google Chrome and falls back to Playwright's Chromium.
It keeps a detached daemon, so browser state survives between commands — that is
what makes a multi-step run possible from a shell.

## 2. Agree the run before touching the site

Collect, or state your assumptions for: target URL (prod / staging / local),
whether login is needed, and the numbered step list with one expected result per
step. A step with no expected result is not a test.

```bash
mkdir -p .tmp/live-qa/$(date +%Y%m%d-%H%M)
```

Screenshots are `NN-<step>.png` in step order, same directory, never reused.

## 3. The per-step loop

```bash
D="node $SKILL_DIR/scripts/drive.mjs"      # or your agent's native browser tool
$D start https://stage.example.com --viewport 1280x800
```

For each step:

1. **Look** — `$D links` (every interactive element as `role:name`) and
   `$D text` (visible text). Prefer role+name over CSS: it survives restyling.
2. **Act** — `$D click "button:Login"`, `$D fill "textbox:Email" you@example.com`,
   `$D press Enter`.
3. **Wait on a real condition, not a duration** — `$D wait --text "Dashboard"`,
   `$D wait --url **/dashboard`, `$D wait --selector "#inbox"`. A timeout is not a
   pass; it is a finding.
4. **Screenshot** — `$D shot .tmp/live-qa/<stamp>/01-login.png`. The command prints
   the byte size and fails if the file is empty: that is your evidence check.
5. **Assert** — `$D eval "document.querySelector('.error')?.innerText"` and compare
   with the expected result; `$D console` and `$D network` for the diagnostics you
   report alongside the verdict.

`start` once per run, not per step. Navigation is `click`/`press`, and the daemon
follows it. If your agent has a native browser tool, use its equivalent verbs —
the loop and the evidence rules are identical.

## 4. Verify every artifact before claiming it

A screenshot you did not stat is a guess. `drive.mjs shot` prints
`{"bytes":…}` and exits non-zero on an empty file; the native lanes expose the same
idea (`details.artifactVerification.verified` must be true with
`missingCount/unverifiedCount` at 0). Branch on that, never on a `success`
envelope alone.

## 5. Diagnostics, recording, promo

Load only what the run needs — these live outside this file to keep it small:

- `references/diagnostics-and-recording.md` — console/network/a11y/vitals when a
  step looks wrong, plus the recording caveat (capture is repaint-driven, so a
  video is a state timeline, never evidence about animation smoothness).
- `references/captchas-and-access.md` — Turnstile detection and the verified
  test-sitekey path that mints a token with no interaction, WAF and Cloudflare
  service-token headers, and the line you do not cross on sites you do not own.
- `references/browser-lanes.md` — verb-by-verb mapping between `drive.mjs` and the
  native tools of pi, Claude Code, Codex and Cursor.
- `references/promoting-to-a-spec.md` — turning a green run into a Playwright test.

## 6. Auth — get it once, prove it, never store the password

A login form on the current page proves nothing: an app can render its shell while
every API answers 401. And a password is the wrong thing to keep — the reusable
artifact is the **session** it produces (the same conclusion Playwright's own auth
guide reaches: log in once, save `storageState`, reuse it).

`drive.mjs` implements the four ways to get that session, best first.

### a) A state file — the default

```bash
# once, in a shell that has a TEST account (never a personal one):
LIVE_QA_USER=… LIVE_QA_PASS=… node drive.mjs start https://stage.example.com
node drive.mjs auth login --save .tmp/live-qa/auth/stage.json \
     --user-selector "#username" --pass-selector "#password"
# later, and in CI, with no credentials in the environment at all:
node drive.mjs start https://stage.example.com --storage .tmp/live-qa/auth/stage.json
node drive.mjs auth probe --check https://stage.example.com/dashboard   # must exit 0
node drive.mjs auth probe --check https://stage.example.com/dashboard \
     --api https://stage.example.com/api/me
```

`auth login` fills the form, submits, then **verifies** before it claims success. The
state file holds cookies + localStorage (+ IndexedDB, needed for Firebase/MSAL), is
written `0600` in a `0700` directory, and never contains the password — verified.

### b) A minted token — the CI path

When the backend can issue a session for a test user (the usual "test token
endpoint" pattern in lower environments), inject it and skip the UI entirely:

```bash
SESSION_TOKEN=$(curl -s -X POST "$STAGE/api/test-session" -d '{"role":"qa"}' | jq -r .token)
SESSION_TOKEN="$SESSION_TOKEN" node drive.mjs auth inject \
  --cookie "session=$SESSION_TOKEN" --url https://stage.example.com \
  --check https://stage.example.com/dashboard
# or, for a SPA that keeps a JWT in localStorage:
SESSION_TOKEN=… node drive.mjs auth inject --local-storage "auth_token=SESSION_TOKEN"
```

The value is read in your shell and sent once over the local unix socket; it never
appears in argv, logs or on disk.

### c) A human signs in, you harvest the session — the interactive path

When you do not have the credentials yet (SSO, MFA, a colleague's test account, or you
simply do not want to hold the password), **open the login and let them type it**:

```bash
node drive.mjs auth open https://stage.example.com/login      # visible window
# … the user signs in …
node drive.mjs auth wait --save .tmp/live-qa/auth/stage.json \
     --check https://stage.example.com/dashboard \
     --api   https://stage.example.com/api/me --timeout 120
```

`auth open` opens **one** window and returns immediately, so the terminal is free. Call
it again and it reuses that window (`windowReused: true`) instead of relaunching — which
matters, because relaunching is what throws away a half-typed password and makes the
tool look like "it keeps opening new windows".

`auth wait` polls for up to `--timeout` seconds (default **900**), saves the state the
moment the session exists, prints the account it saw, and then **closes the window** —
the browser has done its job. Pass `--keep-open` if you want to keep looking at it. If
nothing happened in the window it exits 2 and leaves the window alone, so the human can
carry on typing. Add `--capture-creds <file>` and it also writes what was submitted
(`{account, values}`) to a `0600` file — the only way to get a password out of this
tool, and it says so: that file is a password, move it to a secret store and delete it.
The default is the state file, which contains no password at all (verified).

`auth open` also captures nothing until the *form is submitted* in that window, so
opening a login page and walking away yields no secrets.

### d) SSO when the provider blocks automated browsers

Google (and Microsoft, and most banks) refuse `OAuth` sign-in from a browser that
advertises automation — the page reads *"Couldn't sign you in. This browser or app may
not be secure."* Two things matter:

1. `drive.mjs` already launches Chrome **without** `--enable-automation` and with
   `AutomationControlled` disabled, so `navigator.webdriver` is `false` (verified).
   `--automation` puts the flag back, which is how you reproduce a site's bot block.
2. If the provider still refuses (it can decide *after* the password), do not fight it —
   use the browser the human actually uses:

```bash
# the human starts Chrome once, with a debug port, on their own profile
google-chrome --remote-debugging-port=9444 --user-data-dir="$HOME/.config/google-chrome"
# the agent attaches: no automation flags, real cookies, Google is happy
node drive.mjs start https://stage.example.com/login --attach 9444
node drive.mjs click "button:Sign in with Google"        # already signed in → one click
node drive.mjs auth state .tmp/live-qa/auth/stage.json   # harvest the app session
node drive.mjs close
```

Because that profile is already signed into Google, the SSO round-trip is one click and
no identity-provider password is ever typed into an automated browser. Prefer this over
`auth login` for any SSO app.

**Verified end to end on a real app:** copied Chrome profile → launched with
`--remote-debugging-port` → attached → clicked *Sign in with Google* → Google reused the
existing session (account chooser, no password) → app callback set its session cookies →
`auth probe --api …` reported authenticated with the account name in the UI →
`auth state` saved 92 cookies at `0600` → **a fresh browser started with
`--storage` rendered the same signed-in dashboard**. `auth wait` on an attached browser
prints `detached: true` and leaves the human's Chrome running.

### e) SSO — a human signs in, you keep the session

Google/Microsoft/Okta cannot be automated: MFA is the point. Run headed, ask the
user to finish the sign-in in that window, then capture the state:

```bash
node drive.mjs start https://stage.example.com --headed
# … user signs in …
node drive.mjs auth state .tmp/live-qa/auth/stage-sso.json
```

### f) A copied Chrome profile — last resort

`start <url> --profile /path/to/profile` reuses a real profile. It only works if
Chrome is not holding it, cookies decrypt for the same OS user, and the session has
not expired — **verified to fail silently otherwise**, so always follow it with
`auth probe`.

### Five ways an agent can sign in with no human at all

Ranked by how little a human has to do — the top three need nobody in the loop.

| # | Way | Command | Needs |
| --- | --- | --- | --- |
| 1 | **Minted session** | `auth inject --cookie "session=$TOKEN"` / `--local-storage "auth_token=$TOKEN"` | a `/api/test-session` endpoint on a non-production env |
| 2 | **API login (no UI)** | `auth request --method POST --url https://app/api/login --json '{"username":"${LIVE_QA_USER}","password":"${LIVE_QA_PASS}"}'` | the app's own JSON login route; the request runs inside the browser context, so `Set-Cookie` lands in it |
| 3 | **Form login + TOTP** | `auth login --totp-env LIVE_QA_TOTP_SECRET` | a test account with an authenticator secret you own |
| 4 | Google service account | exchange an SA JWT for the app's token in your own script, then `auth inject` | app accepts Google identities |
| 5 | Microsoft client credentials | `POST /{tenant}/oauth2/v2.0/token` with `client_credentials`, then `auth inject` | an app registration; the app must accept the token |

`auth totp` on its own prints the current code (`--at <epoch>` for a fixed moment, `--digits 8`),
and is checked against the RFC 6238 vectors.

### Keeping the session safe (this is the part people get wrong)

A state file **is** a credential: it can drive a logged-in session. Five rules, enforced here:

1. **Encrypt at rest.** Set `LIVE_QA_STATE_KEY` and `auth state` writes `AES-256-GCM` (scrypt-derived
   key, per-file salt, `QAENC1` header) instead of JSON. `--storage` decrypts on load; a wrong or
   missing key fails loudly instead of silently starting a guest session. In CI the key comes from
   Vault / AWS Secrets Manager / Doppler — never from the repo.
2. **Metadata, not secrets**: `auth info <file>` prints cookie count, hosts, `savedAt` and the
   earliest `expiresAt` without revealing a single value.
3. **Short life.** The file records its expiry; re-harvest instead of carrying one file between
   environments. A session that is a week old is a liability, not a convenience.
4. **One file per environment and per role**, `0600` inside a `0700` directory that is gitignored
   (`.tmp/live-qa/auth/`). Never commit it, never paste it into a ticket.
5. **No long-lived passwords.** Credentials come from the environment for the duration of one
   request (`auth login`, `auth request`); nothing is written to disk. `--capture-creds` exists for
   the case where the owner explicitly wants the password, and says so in its output.

## 7. Stop and ask before these

On a real production site, do not perform these without explicit go-ahead —
screenshot the moment before and report the pending action instead:

- anything that deletes or overwrites user data
- payments, orders, subscriptions, plan changes
- sending real email / SMS / invites / chat messages
- account or security changes: password, 2FA, API keys, roles, permissions

Never attempt CAPTCHA or bot-check bypass on a site you do not own — see
`references/captchas-and-access.md` for the legitimate path. Read-only navigation,
filling forms with test data, and inspecting state are ordinary and need no extra
sign-off.

## 8. Failure handling

- Interaction timed out or a mutation's outcome is unknown → **inspect before
  retrying** (`$D url`, `$D links`). Never blind-retry a mutation.
- Click reported as covered by another element → inspect the overlay/blocker rather
  than repeating the click.
- Unexpected origin change or blank page → you are in another tab or a redirect
  landed elsewhere; check `$D url` first.
- A step that cannot be reproduced after two honest attempts is a finding, not a
  failure to hide. Record it and move on.

## 9. Report

One row per step, with the screenshot path and a verdict. Facts only — "no console
errors" means you cleared, reproduced and read the console, not that you never looked.

```markdown
| # | Step | Expected | Observed | Verdict | Evidence |
|---|------|----------|----------|---------|----------|
| 1 | open /login | email + password fields | both present | PASS | 01-login.png |
| 2 | bad password | inline error, no nav | error shown, URL unchanged | PASS | 02-bad-pw.png |
| 3 | valid login | redirect /dashboard | 500 from /api/me | FAIL | 03-login-500.png |
```

Then a short diagnostics section (console errors, failed requests, a11y, CWV) and
one line of summary: steps passed, the single most important failure, what you could
not test.

Close with one verdict word, because that is the line a human forwards and the only
part they read:

- **SHIP** — every step passed, console and network clean.
- **SHIP WITH FIXES** — failures found, none of them blocking.
- **DO NOT SHIP** — a blocking failure, or any step whose outcome is unknown.
- **INCONCLUSIVE** — the run itself could not happen: no credentials, no staging, no
  baseline to compare against.

An unknown outcome is never a pass, and a clean run on the wrong environment is not
evidence about the right one. Say which URL you tested.
