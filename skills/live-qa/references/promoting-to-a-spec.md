# Promoting a live run to a spec

A live run proves the site works now; it does not protect it later. If the user
wants the flow repeatable, turn the stable steps into a Playwright test and
follow the project's own conventions — in this repo that means UI automation
lives in `e2e/ui/`, imports `test`/`expect` from `@/playwright/suite` (never
directly from `@playwright/test`), and uses the shared `tools-dev` harness for
the runtime. Only encode steps that went green; leave the flaky ones as live
findings.
