# live-qa

<h3 align="center">Live QA in a real browser, with a screenshot per step that proves what happened.</h3>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
  <img alt="agents" src="https://img.shields.io/badge/works%20in-pi%20%7C%20Claude%20Code%20%7C%20Codex%20%7C%20Cursor-4B5563?style=flat-square">
  <img alt="skillspector" src="https://img.shields.io/badge/SkillSpector-0%2F100%20SAFE-2EA043?style=flat-square">
  <img alt="cost" src="https://img.shields.io/badge/session%20cost-~110%20tok-6E7681?style=flat-square">
</p>

<p align="center">
  <img alt="live-qa demo — real run, regenerable from demos/live-qa.json" src="skills/live-qa/assets/demo.gif" width="900">
</p>

## What it is

`live-qa` is a **procedure and a small browser driver**: it walks a flow one user-visible
step at a time, saves a numbered screenshot for each step, and ends with a pass/fail table plus the
console errors and failed requests behind every verdict. You point it at a staging URL and a list of
steps; you get evidence, not an opinion.

## The problem it removes

Agent QA usually ends in one of two useless places: a throwaway Playwright file nobody runs
again, or "looks good" in chat with nothing attached. Neither survives a code review. This produces the
thing a reviewer actually asks for: *what did you click, what did you see, and what did the console say.*

## Install

```bash
# Claude Code — the whole collection as one marketplace
claude plugin marketplace add Appit-labs/appit-skills
claude plugin install live-qa@appit-skills

# pi
pi install git:github.com/Appit-labs/live-qa

# any agent that reads a skills directory
git clone git@github.com:Appit-labs/live-qa.git
cp -r live-qa/skills/live-qa ~/.claude/skills/      # or ~/.codex/skills/, .cursor/skills/, …
```

## Use

- **A full pass** — ask for live QA of a flow; it agrees the step list and expected result per step first
- **One flow, forced** — `/skill:live-qa test the checkout flow on staging`
- **Regression suite** — `references/promoting-to-a-spec.md` — only steps that went green

## Logging in, without storing a password

Four ways to get an authenticated session, best first — the reusable artifact is the
**session**, never the password (the same conclusion Playwright's own auth guide reaches):

```bash
# 1. a state file: log in once with a TEST account, reuse cookies + localStorage
LIVE_QA_USER=… LIVE_QA_PASS=… node <skill>/scripts/drive.mjs start https://stage.example.com
node <skill>/scripts/drive.mjs auth login --save .tmp/live-qa/auth/stage.json
node <skill>/scripts/drive.mjs start https://stage.example.com --storage .tmp/live-qa/auth/stage.json

# 2. a minted token: no UI login at all (the CI path)
SESSION_TOKEN=$(curl -s -X POST "$STAGE/api/test-session" | jq -r .token) \
  node <skill>/scripts/drive.mjs auth inject --cookie "session=$SESSION_TOKEN"

# 3. no credentials yet? open the login for a human, then harvest what they did
node <skill>/scripts/drive.mjs auth open https://stage.example.com/login
# … the person signs in (SSO, MFA, test account — you never hold the password) …
node <skill>/scripts/drive.mjs auth wait --save .tmp/live-qa/auth/stage.json \
     --check https://stage.example.com/dashboard --timeout 120
# add --capture-creds file.json only if they agreed: that file IS a password (0600)

# 4. always prove it — exits 0 only when actually authenticated
node <skill>/scripts/drive.mjs auth probe \
  --check https://stage.example.com/dashboard --api https://stage.example.com/api/me
```

Rules the tool enforces: credentials only from `$LIVE_QA_USER` / `$LIVE_QA_PASS` (never
argv, never disk, never screenshotted); state files are `0600` in a `0700` `.tmp/` dir
and contain no password; `auth probe` refuses to let you confuse "page rendered" with
"signed in" — it checks for a login form, a redirect to `/login`, and the status code of
an authenticated endpoint.

## What it does not do

- It does not write a test suite for you; promotion is a deliberate, separate step.
- It does not bypass bot protection on sites you do not own, and never uses a solver.

## Requires

- **Node 18+ and Playwright** — `npm i -D playwright` (the driver ships in `scripts/drive.mjs`; real Chrome is used when installed).
- Optional: a native browser tool (pi's `agent_browser`, a Playwright/DevTools MCP server). `references/browser-lanes.md` maps the verbs.
- `ffmpeg` only for a recording.

## Cost

| | tokens |
| --- | --- |
| always-on — the description, paid every session | ~110 |
| on invoke | ~2k |

The demo above is not a mockup: `demos/live-qa.json` holds the captured run and
`tools/make_demo.py` renders it, so it can be regenerated and audited.

## Security

SkillSpector: **0/100, SAFE, 0 open findings** against the committed baseline. Every accepted
finding is listed with its reason in [SECURITY.md](SECURITY.md). No `shell=True`, no credential
storage, no network destination chosen at runtime.

## Part of the Appit collection

[appit-skills](https://github.com/Appit-labs/appit-skills) — browser QA · CI triage · Postgres · runbooks ·
SSH · Trello · cloud browsers · OpenDesign · Blender.

## License

MIT, copyright Appit Labs. See [LICENSE](LICENSE).
