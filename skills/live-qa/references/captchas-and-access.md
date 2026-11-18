# CAPTCHAs and gated access

Only relevant when you are testing a site you own or are explicitly authorized to
test. Never solve a live challenge on a site you do not own — no solver services,
no fingerprint patching, no retry loops.

## Turnstile: detect, then take the token path

Detection (paste into `eval --stdin`):

```js
(() => {
  const w = [...document.querySelectorAll('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"]')];
  const r = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
  return JSON.stringify({
    widgets: w.length,
    sitekeys: [...new Set([...document.querySelectorAll('[data-sitekey]')].map(e => e.dataset.sitekey))],
    api: typeof window.turnstile,
    tokenLen: r ? (r.value || '').length : null,
    env: window.ENV ? Object.keys(window.ENV) : null
  });
})()
```

`tokenLen > 0` means the widget already passed with no interaction — the normal
case for a clean browser with a valid sitekey. Nothing to bypass.

**Site you own — the token path that always works.** Turnstile's documented test
sitekey mints a token with zero interaction:

```js
(async () => {
  const box = document.createElement('div'); box.id = 'qa-ts'; document.body.appendChild(box);
  const id = window.turnstile.render(box, {
    sitekey: '1x00000000000000000000AA',
    callback: t => { box.dataset.token = t; }
  });
  await new Promise(r => setTimeout(r, 5000));
  return JSON.stringify({ widgetId: id, token: (box.dataset.token || '').slice(0, 24) });
})()
```

Verified to return `XXXX.DUMMY.TOKEN.XXXX…` with no click and no solver. It is only
accepted end-to-end if the backend verifies with the matching test secret
(`1x0000000000000000000000000000000AA`): use both on staging, and never swap
production keys to make a test pass.

**A real widget that yields no token is a site bug, not a blocked bot.** Verified on a
real production contact form: the widget was marked rendered, its challenge iframe
request returned 200, and the token stayed empty for 15 s in both headless and headed
browsers. Causes are the sitekey being bound to another
hostname, a mismatched `action`, or a form that never calls `reset` after a retry
(tokens are single-use). Report it — a real user cannot submit that form either, and
a solver would pass the widget and still fail the backend check.

### Site you own (or are explicitly authorized to test)

Make the challenge deterministic instead of beating it, cheapest first:

1. **Test-mode flag.** Env/config that disables the check outside production.
   Cheapest, but prod's real widget never gets exercised — say so in the report.
2. **Vendor test keys.** Published, always pass, safe to commit to a test
   config:

   | Provider | Site key | Secret key |
   |---|---|---|
   | reCAPTCHA v2 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` | `6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe` |
   | hCaptcha (publisher) | `10000000-ffff-ffff-ffff-000000000001` | `0x0000000000000000000000000000000000000000` |
   | hCaptcha (enterprise, safe end user) | `20000000-ffff-ffff-ffff-000000000002` | `0x0000000000000000000000000000000000000000` |
   | Turnstile (visible, pass) | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
   | Turnstile (visible, fail) | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |
   | Turnstile (invisible, pass/fail) | `1x00000000000000000000BB` / `2x00000000000000000000BB` | `1x…AA` / `2x…AA` |
   | Turnstile (force challenge) | `3x00000000000000000000FF` | `1x0000000000000000000000000000000AA` |
   | Turnstile (duplicate token) | — | `3x0000000000000000000000000000000AA` |

   **reCAPTCHA v3 has no test keys.** Create a separate test key; expect
   unreliable scores because v3 needs real traffic. Lower the threshold or skip
   the check in the dev build.
3. **Rewrite the sitekey in flight** when staging can't be redeployed: intercept
   the document response and replace `data-sitekey` before the widget script
   reads it. Only works if the backend also uses a test secret.
4. **Assert both paths.** A CAPTCHA flow needs a negative control: submit with
   no token and with a bad token, and assert the server rejects. Swapping in
   test keys proves the happy path only.

Gotchas that cost real debugging time:

- **Turnstile: swapping only the sitekey breaks validation.** A production
  secret rejects the dummy token (`XXXX.DUMMY.TOKEN.XXXX`), so you get a failure
  that looks like an app bug. Both sides must be test keys.
- Test keys render a visible warning banner — expected, not a UI defect.
- Test keys work on any domain including localhost; production keys need
  separate hostname allowlisting, so a "works locally, blocked on staging"
  failure is often key configuration, not code.
- Never ship test keys to production.

### Blocked at the edge (WAF / bot management), site you own

Do not defeat the challenge — make your own edge let you through. This is the
only approach that is both reliable and stable, because it cannot be
re-tuned against you:

1. **WAF custom rule with the Skip action**, scoped to your test identity — a
   secret header, a path prefix, or your CI egress IP. Skip disables named
   security features for matching requests.
2. **IP Access rule → allow** for your egress IP/ASN. Bypasses custom rules,
   rate limiting, and managed rules for that address.
3. **Cloudflare Access service token** for apps behind Access: send
   `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Gotcha: the token
   needs a policy whose action is **Service Auth**, not `Allow` — attached to an
   `Allow`-only policy it is silently ignored, which reads like "the header does
   nothing".
4. **Turnstile pre-clearance** when the widget has to stay live.

Before you debug your app over this: **Bot Fight Mode cannot be skipped** by a
WAF Skip rule or a Page Rule. If BFM is enabled, the exemption has to come from
IP Access rules or from a paid Super Bot Fight Mode configuration. "My skip rule
has no effect" is almost always this.

### Site you do not own

Stop and report the step as blocked, with a screenshot of the challenge. Do not
use solver services, stealth/fingerprint patching, or retry loops to get past it.
Circumventing another site's access control is exactly what their terms and
anti-circumvention law target, and a QA run against a site you don't own isn't
QA — nothing you find there is actionable for you.
