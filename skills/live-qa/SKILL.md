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

## 6. Auth — and proving it worked

Being on a page is not being signed in. Two failures cost runs: a redirect you did
not notice, and a UI that renders its shell while every API call returns 401.
Prove state first:

```bash
$D eval "JSON.stringify({url: location.href, loginForm: !!document.querySelector('input[type=password], input[name=username]')})"
$D network        # a 401 from any authenticated endpoint means you are a guest
```

Ways to get a real session, best first:

1. **A profile directory** — `start <url> --profile /path/to/profile` reuses that
   profile's login state. It must not be locked by a running browser; copy it if the
   user's Chrome is open: `cp -r ~/.config/google-chrome/Default /tmp/qa-prof`.
   **Verified limit:** cookies only decrypt for the same OS user, and nothing is
   restored if the session had already expired there. Prove the login with the check
   above; never assume it.
2. **Test account** — if the user provides one (env var, secrets manager), fill and
   submit the login form. That is a real mutation: ask first, and never put the
   password in a screenshot or the report.
3. **SSO (Google / Microsoft)** — cannot be automated: it is the user's account and
   their 2FA. Run headed (`--headed`) and ask them to finish it in that window, then
   continue.

If none works, say "I could not get an authenticated session" and test only the
public surface. An untested authenticated flow is a finding, not something to paper
over.

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
