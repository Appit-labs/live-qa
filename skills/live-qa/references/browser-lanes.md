# Browser lanes: same loop, different verbs

The QA loop (look → act → wait → shoot → assert) is identical everywhere. Only the
verbs change. Pick the lane your agent supports and translate; do not mix lanes in
one run.

## Lane 1 — `scripts/drive.mjs` (works in every agent)

```bash
D="node <skill-dir>/scripts/drive.mjs"
$D start <url> [--headed] [--viewport 1280x800] [--profile DIR]
$D links | $D text | $D url
$D click "button:Login" | $D fill "textbox:Email" you@example.com | $D press Enter
$D wait --text "Dashboard" | --url '**/dashboard' | --selector '#inbox'
$D shot 03-dashboard.png [--full]
$D eval "document.title"
$D console [--clear] | $D network [--clear]
$D close
```

Needs Node 18+ and Playwright (`npm i -D playwright`). Uses real Chrome when
installed, else Playwright's Chromium. A detached daemon holds the browser, so
state survives between commands.

## Lane 2 — pi's native browser tool

| drive.mjs | pi |
| --- | --- |
| `start <url>` | `agent_browser ["open", "<url>"]`, `sessionMode:"fresh"` when switching profile/provider |
| `links` / `text` | `agent_browser ["snapshot","-i"]` reads interactive refs |
| `click "button:X"` | `agent_browser_action { action:"click", locator:"role", role:"button", name:"X" }` |
| `fill` | `agent_browser_action { action:"fill", ... , value:"..." }` |
| `wait --text X` | `agent_browser ["wait","--text","X"]` |
| `shot f.png` | `agent_browser ["screenshot", f]` → check `details.artifactVerification.verified` |
| `console` / `network` | `agent_browser ["errors"]` / `["network","requests"]` |
| `eval` | `agent_browser ["eval","--stdin"]` |

Extra pi-only verbs worth using when available: `agent_browser_qa { attached:true,
expectedText:[...] }` (attached mode keeps the page; passing `url` re-navigates and
destroys state), `record start/stop` for video, `a11y --tags wcag2a,wcag2aa`,
`vitals` for Core Web Vitals.

## Lane 3 — Claude Code with a Playwright or Chrome-DevTools MCP server

The tools appear as `mcp__<server>__*`; map them the same way (`navigate` →
`start`, `snapshot` → `links`, `screenshot` → `shot`, `console_messages` →
`console`, `network_requests` → `network`). If no browser MCP server is installed,
Lane 1 is the answer — it needs nothing but Node.

## Lane 4 — Codex / Cursor / Gemini CLI / anything else

No browser tool of their own. Use Lane 1 and keep every step as a shell command;
the run then reads the same in the transcript and in the report.

## Choosing a lane in one sentence

Native tool if your agent has one (fewer round trips, better refs); `drive.mjs`
otherwise (portable, scriptable, screenshot bytes verified). Never mix: state lives
in one browser.
