# live-qa

<h3 align="center">Live QA in a real browser, with a screenshot per step that proves it happened.</h3>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
  <img alt="agents" src="https://img.shields.io/badge/works%20in-pi%20%7C%20Claude%20Code%20%7C%20Codex%20%7C%20Cursor-4B5563?style=flat-square">
  <img alt="skillspector" src="https://img.shields.io/badge/SkillSpector-0%2F100%20SAFE-2EA043?style=flat-square">
  <img alt="tokens" src="https://img.shields.io/badge/session%20cost-~110%20tok-6E7681?style=flat-square">
</p>

<p align="center">
  <img alt="live-qa demo" src="skills/live-qa/assets/demo.gif" width="820">
</p>

## Install

One command for each agent — the skill is plain Markdown plus a script, so nothing is coupled to one ecosystem.

```bash
# Claude Code (plugin, stays updatable)
claude plugin marketplace add ibrahimbdr/appit-skills
claude plugin install live-qa@appit-skills

# pi
pi install git:github.com/ibrahimbdr/live-qa

# any agent that reads a skills directory
git clone git@github.com:ibrahimbdr/live-qa.git
cp -r live-qa/skills/live-qa ~/.claude/skills/      # or ~/.codex/skills/, .cursor/skills/, …
```

## Why this exists

Agent QA usually ends as either a throwaway Playwright file or a vague "looks good". This produces evidence per step instead: numbered screenshots, a pass/fail table, and the console/network facts behind each verdict.

## Use

- Run a pass: `ask for a live QA of a flow; the skill agrees the step list first, then executes it`
- Force it: `/skill:live-qa test the checkout flow on staging`
- Promote to a suite: `references/promoting-to-a-spec.md` — only steps that went green`

## Requires

- **Node 18+ with Playwright** — `npm i -D playwright` (the skill ships its own driver; real Chrome is used when installed).
- Optional: any native browser tool (pi's `agent_browser`, a Playwright/Chrome-DevTools MCP server). `references/browser-lanes.md` maps the verbs both ways.
- `ffmpeg` only if you ask for a recording.

## What you get

- Every screenshot is byte-verified before it is reported; an empty file is a failure, not evidence.
- Ships a verified Turnstile procedure: detect the widget, read the token, and the documented test-sitekey path that mints a token with no solver.
- Auth is proved, not assumed: a page that renders while `/api/…` returns 401 is a guest session.
- Hard stop-list for production: deletes, payments, real emails, account changes — screenshot and ask first.

## Cost

| | tokens |
| --- | --- |
| always-on (the description, every session) | ~110 |
| on invoke | ~2k |

The demo above is regenerated from a real run: `demos/live-qa.json` holds the captured
output, `tools/make_demo.py` renders it. No invented screenshots.

## Security

Static analysis with SkillSpector: **0/100, SAFE, 0 open findings** against the committed
baseline. Every accepted finding is listed with its reason in [SECURITY.md](SECURITY.md).
The skill never uses `shell=True`, never reads or stores a credential, and never chooses a
network destination at runtime.

## Part of the Appit collection

Browser QA · CI triage · Postgres · runbooks · SSH · Trello · cloud browsers · OpenDesign · Blender —
one marketplace: [appit-skills](https://github.com/ibrahimbdr/appit-skills).

## License

MIT. See [LICENSE](LICENSE).
