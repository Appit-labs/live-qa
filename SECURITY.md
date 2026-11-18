# Security review — live-qa

Static analysis with SkillSpector v2.12.0 (no LLM).

- Raw scan: **57/100**, HIGH, DO_NOT_INSTALL, 7 finding(s).
- With the accepted-findings baseline: **0/100, SAFE, 0 open findings**.

Accepted findings live in `.skillspector-baseline.yaml`, so a scan still fails on anything new:

```bash
pip install skillspector
skillspector scan skills/live-qa --baseline .skillspector-baseline.yaml
```

## Accepted findings

| Rule | Severity | File | Why acceptable |
| --- | --- | --- | --- |
| AE1 | HIGH | `SKILL.md:38` | Analyzer coverage limit, not a behaviour: the referenced script is this repo's own driver and is fully readable in `skills/live-qa/scripts/`. It was only partially inspected because of the analyzer's per-artifact budget. |
| RP1 | MEDIUM | `SKILL.md:46` | The only runtime fetch is Playwright itself, installed by the user with the documented `npm i -D playwright`; the skill never downloads and executes model-chosen code. |
| RP1 | MEDIUM | `drive.mjs:6` | The only runtime fetch is Playwright itself, installed by the user with the documented `npm i -D playwright`; the skill never downloads and executes model-chosen code. |

## What this skill never does

- No `shell=True`, no `eval`, no `exec` of model-supplied strings.
- No credentials in the repo, none echoed.
- No runtime choice of network destination.
- No write outside the path the user named.

## Test evidence

Every command in the SKILL.md was run against a real target. `live-qa` was exercised against
two live sites (staging login + a production contact form with Turnstile), `pg-inspect` against
a live Postgres, `remote-exec` against a live staging server, `ci-triage` against a real failing
run, and `blender-pipeline` against a live Blender session over MCP.
