#!/usr/bin/env node
/**
 * drive.mjs — one browser, driven from a shell, with no agent-specific tools.
 *
 * Works with any coding agent that can run a command. Needs Node 18+ and Playwright:
 *   npm i -D playwright        # then: npx playwright install chromium   (or use real Chrome)
 *
 *   node drive.mjs start <url> [--headed] [--channel chrome] [--viewport 1280x800] [--profile DIR]
 *   node drive.mjs text [--limit 3000]        # visible text, compacted
 *   node drive.mjs links [--limit 60]         # interactive elements as role:name
 *   node drive.mjs shot <file.png> [--full]   # screenshot; prints verified byte size
 *   node drive.mjs click  "role:name" | --selector "css"
 *   node drive.mjs fill   "role:name" <value> | --selector "css"
 *   node drive.mjs press  <key>
 *   node drive.mjs wait   --text X | --selector X | --url X [--timeout 15000]
 *   node drive.mjs eval   "<js expression>"
 *   node drive.mjs console [--clear]          # page errors + console.error/warn
 *   node drive.mjs network [--clear]          # failed requests (fetch >=400 and net errors)
 *   node drive.mjs url
 *   node drive.mjs close
 *
 * `start` launches a detached daemon that owns the browser, so state survives between
 * commands. The daemon speaks JSON over a UNIX socket in /tmp/qa-driver/daemon.sock.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, chmodSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHmac } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = process.env.QA_DRIVER_DIR || "/tmp/qa-driver";

/* Playwright is resolved from wherever it exists: this project, a global install, or the
 * npx cache. That is what lets the same script run in any agent without a node_modules
 * copy inside the skill. */
function loadPlaywright() {
  const roots = [
    process.env.PLAYWRIGHT_ROOT,
    process.cwd(),
    join(homedir(), ".npm", "_npx"),
    "/usr/lib/node_modules",
    join(homedir(), ".nvm"),
  ].filter(Boolean);
  const tries = [];
  try { return createRequire(join(process.cwd(), "noop.js"))("playwright"); } catch (e) { tries.push("cwd"); }
  for (const root of roots) {
    const dirs = root.endsWith("_npx")
      ? readdirSync(root).map((d) => join(root, d, "node_modules")).filter((d) => existsSync(d))
      : [root, join(root, "lib", "node_modules")];
    for (const d of dirs) {
      try { return createRequire(join(d, "noop.js"))("playwright"); } catch { tries.push(d); }
    }
  }
  console.error("playwright not found (looked in " + tries.slice(0, 4).join(", ") + "…)\n" +
    "install it once:  npm i -D playwright   # or: npm i -g playwright");
  process.exit(3);
}
const { chromium } = loadPlaywright();
const SOCK = `${DIR}/daemon.sock`;
const INIT = `
window.__qa = window.__qa || { console: [], errors: [], failed: [] };
(() => {
  if (window.__qaHooked) return; window.__qaHooked = true;
  const c = window.__qa;
  const ce = console.error.bind(console), cw = console.warn.bind(console);
  console.error = (...a) => { c.console.push({ level: "error", text: a.map(String).join(" ").slice(0, 400) }); ce(...a); };
  console.warn  = (...a) => { c.console.push({ level: "warn",  text: a.map(String).join(" ").slice(0, 400) }); cw(...a); };
  addEventListener("error", e => c.errors.push(String(e.message || e).slice(0, 300)));
  addEventListener("unhandledrejection", e => c.errors.push("unhandledrejection: " + String(e.reason).slice(0, 300)));
  // Record login submissions (form or JSON) so a session that a human established can
  // also yield the account it used. Memory only; nothing is sent anywhere.
  c.submits = [];
  const grab = (pairs) => {
    const rec = {};
    for (const [k, v] of pairs) {
      if (typeof v === "string" && v && !/^(true|false|on)$/i.test(v)) rec[k] = v;
    }
    if (Object.keys(rec).some(k => /pass|secret/i.test(k))) c.submits.push({ at: Date.now(), url: location.href, values: rec });
  };
  addEventListener("submit", (e) => {
    try { grab(new FormData(e.target).entries()); } catch {}
  }, true);
  const of = window.fetch;
  window.fetch = async (...a) => {
    try {
      const body = a[1] && a[1].body;
      if (typeof body === "string" && /pass/i.test(body)) {
        try { grab(Object.entries(JSON.parse(body)).map(([k, v]) => [k, String(v)])); } catch {}
      }
      const r = await of(...a); if (r.status >= 400) c.failed.push({ status: r.status, url: String(a[0]).slice(0, 200) }); return r; }
    catch (e) { c.failed.push({ status: "net-error", url: String(a[0]).slice(0, 200) }); throw e; }
  };
})();
`;
const isDaemon = process.argv.includes("--daemon");
const MAGIC = "QAENC1";

function stateKey(flags = {}) {
  // The passphrase belongs to the shell that runs the command, so the client hands it
  // over (in memory) when the daemon does not have it.
  const fromEnv = flags["key-value"] || process.env[flags["key-env"] || "LIVE_QA_STATE_KEY"];
  if (fromEnv) return Buffer.from(fromEnv, "utf8").length >= 16 ? Buffer.from(fromEnv, "utf8") : scryptSync(fromEnv, "live-qa", 32);
  return null;
}

function encryptState(payload, key) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const k = scryptSync(key, salt, 32);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return [MAGIC, salt.toString("base64"), iv.toString("base64"), c.getAuthTag().toString("base64"),
          body.toString("base64")].join("\n");
}

function decryptState(text, key) {
  const [magic, salt, iv, tag, body] = text.split("\n");
  if (magic !== MAGIC) return JSON.parse(text);
  const k = scryptSync(key, Buffer.from(salt, "base64"), 32);
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8"));
}

function readStateFile(file, flags = {}) {
  const raw = readFileSync(file, "utf8");
  if (!raw.startsWith(MAGIC)) return JSON.parse(raw);
  const key = stateKey(flags);
  if (!key) throw new Error(`${file} is encrypted: set $LIVE_QA_STATE_KEY (or --key-env NAME)`);
  try { return decryptState(raw, key); }
  catch { throw new Error(`cannot decrypt ${file}: wrong passphrase`); }
}

function totp(secret, at = Date.now(), digits = 6, step = 30) {
  const b32 = secret.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of b32) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("secret is not base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const h = createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };
// Inside the daemon a bad request must not kill the browser: throw, let the reply carry it.
const bad = (msg) => { throw new Error(msg); };

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

/* ------------------------------------------------------------------ daemon */

async function daemon() {
  let ctx, page, headed = false, attached = null;
  try { rmSync(SOCK); } catch {}
  mkdirSync(DIR, { recursive: true });

  // Google, Microsoft and a few banks refuse OAuth in a browser that advertises
  // navigator.webdriver. Playwright sets it via --enable-automation, so drop that flag
  // (pass --automation only to reproduce a site's bot block).
  const humanish = {
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled",
           "--no-default-browser-check", "--no-first-run"],
  };
  async function shutdownBrowser() {
    if (attached) { await attached.close().catch(() => {}); attached = null; return "detached"; }
    await ctx?.close().catch(() => {});
    return "closed";
  }

  const launch = async (opts) => {
    try { return await chromium.launchPersistentContext(`${DIR}/profile`, { ...humanish, ...opts, channel: "chrome" }); }
    catch (e) {
      const m = String(e.message);
      if (m.includes("Chromium distribution") || m.includes("Executable doesn't exist")) {
        return chromium.launchPersistentContext(`${DIR}/profile`, { ...humanish, ...opts });
      }
      throw e;
    }
  };

  const handlers = {
    async start({ positional, flags }) {
      const opts = { headless: !flags.headed, viewport: { width: 1280, height: 800 } };
      if (flags.automation) { opts.ignoreDefaultArgs = []; opts.args = []; }
      if (flags.viewport) {
        const [w, h] = String(flags.viewport).split("x").map(Number);
        opts.viewport = { width: w, height: h };
      }
      if (flags.attach) {
        // Attach to a Chrome the human started. No automation flags, no fresh profile:
        // this is the only reliable way past Google/Microsoft SSO bot checks.
        attached = await chromium.connectOverCDP(`http://127.0.0.1:${flags.attach}`);
        ctx = attached.contexts()[0] || (await attached.newContext());
        await ctx.addInitScript(INIT);
        page = ctx.pages()[0] || (await ctx.newPage());
        if (positional[0]) await page.goto(positional[0], { waitUntil: "domcontentloaded", timeout: 60000 });
        return { url: page.url(), title: await page.title(), attached: flags.attach };
      }
      let restore = null;
      if (flags.storage) {
        restore = readStateFile(flags.storage, flags);
      }
      ctx = await launch(opts);
      if (restore) await applyState(ctx, restore);   // launchPersistentContext ignores storageState
      await ctx.addInitScript(INIT);
      page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(positional[0], { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(400);
      return { url: page.url(), title: await page.title() };
    },
    async url() { return { url: page.url(), title: await page.title() }; },
    async text({ flags }) {
      const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
      return { text: t.slice(0, Number(flags.limit || 3000)) };
    },
    async links({ flags }) {
      const items = await page.evaluate(() =>
        [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link]")]
          .map(el => {
            const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : el.tagName === "BUTTON" ? "button" : el.tagName.toLowerCase());
            const name = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
            return name ? `${role}:${name}` : null;
          }).filter(Boolean)
      );
      return { links: [...new Set(items)].slice(0, Number(flags.limit || 60)) };
    },
    async shot({ positional, flags }) {
      await page.screenshot({ path: positional[0], fullPage: !!flags.full });
      const bytes = readFileSync(positional[0]).length;
      if (!bytes) throw new Error(`screenshot wrote 0 bytes to ${positional[0]}`);
      return { file: positional[0], bytes, url: page.url() };
    },
    async click({ positional, flags }) { await locator({ positional, flags }).click({ timeout: Number(flags.timeout || 15000) }); await page.waitForTimeout(600); return { url: page.url() }; },
    async fill({ positional, flags }) {
      const loc = locator({ positional, flags });
      await loc.fill(String(positional[1] ?? ""), { timeout: Number(flags.timeout || 15000) });
      return { value: await loc.inputValue().catch(() => "?") };
    },
    async press({ positional }) { await page.keyboard.press(positional[0]); await page.waitForTimeout(400); return { url: page.url() }; },
    async wait({ flags }) {
      const timeout = Number(flags.timeout || 15000);
      if (flags.text) await page.getByText(String(flags.text)).first().waitFor({ timeout });
      else if (flags.selector) await page.locator(String(flags.selector)).first().waitFor({ timeout });
      else if (flags.url) await page.waitForURL(String(flags.url), { timeout });
      else throw new Error("wait needs --text, --selector or --url");
      return { url: page.url() };
    },
    async eval({ positional }) {
      const v = await page.evaluate(positional[0]);
      return { value: typeof v === "string" ? v : JSON.stringify(v) };
    },
    async console({ flags }) {
      const data = await page.evaluate(() => window.__qa || {});
      if (flags.clear) await page.evaluate(() => { window.__qa.console = []; window.__qa.errors = []; });
      return { errors: data.errors || [], console: (data.console || []).slice(-30) };
    },
    async network({ flags }) {
      const data = await page.evaluate(() => (window.__qa && window.__qa.failed) || []);
      if (flags.clear) await page.evaluate(() => { window.__qa.failed = []; });
      return { failed: data };
    },

    /* ---------------------------------------------------------- auth --------- */
    async state({ positional, flags = {} }) {
      // storageState = cookies + localStorage (+ IndexedDB). It is a live session:
      // write it 0600, under a directory the project ignores, never into git.
      const file = positional[0] || bad("state needs a file path");
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      await ctx.storageState({ path: tmp, indexedDB: true });
      let state = JSON.parse(readFileSync(tmp, "utf8"));
      const expiries = (state.cookies || []).map(c => c.expires).filter(e => e > 0);
      state.savedAt = new Date().toISOString();
      state.expiresAt = expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null;
      const key = stateKey(flags);
      writeFileSync(tmp, key ? encryptState(state, key) : JSON.stringify(state));
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, file);
      return { file, cookies: (state.cookies || []).length, origins: (state.origins || []).length,
               bytes: readFileSync(file).length, encrypted: Boolean(key),
               savedAt: state.savedAt, expiresAt: state.expiresAt };
    },

    async "auth-login"(req) {
      const { flags } = req;
      const userEnv = flags["user-env"] || "LIVE_QA_USER";
      const passEnv = flags["pass-env"] || "LIVE_QA_PASS";
      const user = flags["user-value"] || process.env[userEnv];
      const pass = flags["pass-value"] || process.env[passEnv];
      if (!user || !pass) {
        return { error: `no credentials in the environment: expected $${userEnv} and $${passEnv}. ` +
          "Export them in this shell (they are never written to disk), or use `auth manual` for SSO." };
      }
      const userSel = flags["user-selector"] ||
        "input[name=username], input[name=user-name], input#username, input[id*=user i], input[type=email]";
      const passSel = flags["pass-selector"] || "input[type=password]";
      const submitSel = flags["submit-selector"] ||
        'input[type=submit], button[type=submit], button:has-text("Login"), button:has-text("Sign in")';
      await page.locator(userSel).first().fill(user, { timeout: 15000 });
      await page.locator(passSel).first().fill(pass, { timeout: 15000 });
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
        page.locator(submitSel).first().click({ timeout: 15000 }),
      ]);
      await page.waitForTimeout(800);
      // A second step (authenticator code) is the usual follow-up. If an OTP secret was
      // provided, complete it — a dedicated test secret, not a bypass of the MFA.
      const totpEnv = flags["totp-env"];
      if (totpEnv && process.env[totpEnv]) {
        const codeField = page.locator('input[name*=code i], input[id*=code i], input[autocomplete="one-time-code"]').first();
        if (await codeField.count()) {
          const code = totp(process.env[totpEnv]);
          await codeField.fill(code, { timeout: 10000 }).catch(() => {});
          const submit = page.locator('input[type=submit], button[type=submit]').first();
          await Promise.all([
            page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
            submit.click({ timeout: 10000 }).catch(() => {}),
          ]);
          await page.waitForTimeout(800);
        }
      }
      const after = await probeState(req);
      if (!after.authenticated) return { ...after, error: "still not authenticated after submit" };
      if (flags.save) {
        const saved = await handlers.state({ positional: [flags.save] });
        return { ...after, stateFile: saved.file, cookies: saved.cookies };
      }
      return after;
    },

    async "auth-open"(req) {
      // Hand the login to a human: open a visible window, install the capture hook,
      // return immediately. `auth wait` picks it up when the sign-in completes.
      const { positional, flags } = req;
      let reused = false;
      if (ctx && headed) {
        // A window is already open for the human: keep it. Navigating away would throw
        // away a half-typed password and look like "it keeps opening new windows".
        reused = true;
        if (positional[0] && !page.url().startsWith(positional[0])) {
          await page.goto(positional[0], { waitUntil: "domcontentloaded", timeout: 60000 });
        }
      } else {
        if (ctx) await ctx.close().catch(() => {});
        ctx = await launch({ headless: false, viewport: { width: 1280, height: 860 } });
        headed = true;
        await ctx.addInitScript(INIT);
        page = ctx.pages()[0] || (await ctx.newPage());
        if (positional[0]) await page.goto(positional[0], { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      return { url: page.url(), headed: true, windowReused: reused,
               message: "sign in in the window that is open, then run: drive.mjs auth wait --save <file> " +
                        "(it closes the window when the session exists)" };
    },

    async "auth-wait"(req) {
      const { flags } = req;
      const timeout = Number(flags.timeout || 900) * 1000;
      const started = Date.now();
      let last = null;
      let captured = [];
      // Poll on the page the human is looking at: navigating to --check would wipe the
      // in-page record of what they submitted. Verify with --check afterwards.
      const pollReq = { ...req, flags: { ...flags, check: undefined } };
      while (Date.now() - started < timeout) {
        // Read whatever was submitted *before* anything can navigate away from it.
        try {
          const seen = await page.evaluate(() => (window.__qa && window.__qa.submits) || []);
          if (seen.length) captured = seen;
        } catch {}
        last = await probeState(pollReq);
        if (last.authenticated) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      if (!last.authenticated && flags.check) {
        // Nothing happened in the window, but the session may already be valid (a state
        // file, a cookie the app set silently). One navigation decides — at the end, so
        // it never interrupts someone typing.
        last = await probeState(req);
      }
      if (!last.authenticated) {
        return { ...last, waited: Math.round((Date.now() - started) / 1000),
                 error: "not authenticated yet — finish the sign-in in the window, then re-run auth wait" };
      }
      const out = { ...last, waited: Math.round((Date.now() - started) / 1000) };
      const submits = captured.length ? captured
        : await page.evaluate(() => (window.__qa && window.__qa.submits) || []).catch(() => []);
      if (flags.save) {
        const saved = await handlers.state({ positional: [flags.save] });
        out.stateFile = saved.file;
        out.cookies = saved.cookies;
      }
      const creds = submits.length ? submits[submits.length - 1].values : null;
      if (creds) {
        const userKey = Object.keys(creds).find(k => /user|email|login|account/i.test(k));
        out.account = userKey ? creds[userKey] : null;
        out.passwordField = Object.keys(creds).find(k => /pass|secret/i.test(k)) || null;
        if (flags["capture-creds"]) {
          const file = String(flags["capture-creds"]);
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
          writeFileSync(file, JSON.stringify({ url: out.url, account: out.account, values: creds }, null, 2) + "\n");
          try { chmodSync(file, 0o600); } catch {}
          out.credsFile = file;
          out.warning = "this file holds a password: move it into a secret store and delete it, " +
                        "or keep using the state file instead";
        }
      }
      if (flags.check || flags.api) {
        const verified = await probeState(req);
        out.verified = verified.authenticated;
        out.url = verified.url;
        out.apiStatus = verified.apiStatus;
        if (!verified.authenticated) out.error = "session did not survive the --check probe";
      }
      // Once the session is captured the browser has done its job: close it, unless the
      // caller asked to keep the window (--keep-open).
      if (!flags["keep-open"] && out.verified !== false) {
        out.windowClosed = (await shutdownBrowser()) === "closed";
        out.detached = !out.windowClosed;
        ctx = null;
        page = null;
        headed = false;
      }
      return out;
    },

    async "auth-info"(req) {
      const file = req.positional[0] || bad("auth info needs a file");
      const raw = readFileSync(file, "utf8");
      const state = readStateFile(file, req.flags);
      const cookies = state.cookies || [];
      const expiries = cookies.map(c => c.expires).filter(e => e > 0);
      return { file, encrypted: raw.startsWith(MAGIC), cookies: cookies.length,
               origins: (state.origins || []).length,
               savedAt: state.savedAt || null,
               expiresAt: state.expiresAt || (expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null),
               hosts: [...new Set(cookies.map(c => c.domain))].slice(0, 8),
               appCookies: cookies.map(c => c.name).filter(n => !/^(SID|HSID|SSID|APISID|SAPISID|NID|OSID|LSID|AEC|ACCOUNT_CHOOSER|__Secure-|_ga|IDE|MUID|SRM_B|tuuid|demdex|AMCV|mbox|tvid|CMID|MSFPC|clocale|brcap|wlidperf|OIDC|OTZ|WMF|rlas3|_clck|_utm|VISITOR|LOGIN_INFO|kndctr|__Host-GAPS|Microsoft|MC1|_GRECAPTCHA)/.test(n)) };
    },

    async "auth-request"(req) {
      // API login without any UI: the request runs in the browser context, so the
      // Set-Cookie response lands in the context and the next navigation is signed in.
      const { flags } = req;
      const url = flags.url || bad("auth request needs --url");
      const method = (flags.method || "GET").toUpperCase();
      let data;
      if (flags.json || flags["json-env"]) {
        const src = flags["json-env"] ? process.env[flags["json-env"]] : flags.json;
        if (!src) bad(`env $${flags["json-env"]} is empty`);
        // ${USER}/${PASS} are filled from the caller's environment, never from argv.
        data = String(src).replace(/\$\{?(\w+)\}?/g, (_, name) => process.env[name] ?? "");
      }
      const headers = {};
      if (data) headers["content-type"] = flags["content-type"] || "application/json";
      const resp = await ctx.request.fetch(url, { method, headers, data, maxRedirects: 0, failOnStatusCode: false });
      const setCookies = (resp.headersArray() || []).filter(h => h.name.toLowerCase() === "set-cookie").length;
      return { status: resp.status(), url, method, requestHadBody: Boolean(data),
               setCookieHeaders: setCookies, cookiesNow: (await ctx.cookies()).length };
    },

    async "auth-probe"(req) { return probeState(req); },

    async "auth-inject"(req) {
      // Backend-minted session: pass a token/cookie in from the environment.
      const { flags } = req;
      const url = new URL(flags.url || page.url());
      const injected = [];
      if (flags.cookie) {
        const [name, envVar] = flags.cookie.split("=");
        const value = flags["cookie-value"] || process.env[envVar || name];
        if (!value) bad(`env $${envVar || name} is empty`);
        await ctx.addCookies([{ name, value, domain: flags.domain || url.hostname,
                                path: "/", httpOnly: flags.httpOnly !== false,
                                secure: url.protocol === "https:", sameSite: "Lax" }]);
        injected.push(`cookie ${name}`);
      }
      if (flags["local-storage"]) {
        const [key, envVar] = flags["local-storage"].split("=");
        const value = flags["local-storage-value"] || process.env[envVar || key];
        if (!value) bad(`env $${envVar || key} is empty`);
        await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [key, value]);
        injected.push(`localStorage ${key}`);
      }
      if (!injected.length) bad("nothing to inject: pass --cookie NAME=ENV or --local-storage KEY=ENV");
      if (flags.reload !== false) await page.reload({ waitUntil: "domcontentloaded" });
      const after = await probeState(req);
      return { injected, ...after };
    },

    async close() {
      const how = await shutdownBrowser();
      ctx = null; page = null; headed = false;
      return { closed: true, mode: how };
    },
  };

  // A persistent context ignores the storageState option, so a saved session has to be
  // applied by hand: cookies first, then localStorage per origin at document start.
  async function applyState(context, state) {
    if (state.cookies?.length) await context.addCookies(state.cookies);
    const origins = state.origins || [];
    if (origins.length) {
      await context.addInitScript((entries) => {
        try {
          for (const { origin, localStorage: items } of entries) {
            if (location.origin !== origin) continue;
            for (const { name, value } of items || []) {
              try { window.localStorage.setItem(name, value); } catch {}
            }
          }
        } catch {}
      }, origins);
    }
    return { cookies: (state.cookies || []).length, origins: origins.length };
  }

  async function probeState(req) {
    const { flags } = req;
    // A login form on the *current* page proves little — probe a page that only
    // renders when authenticated, or an API that only answers 200 when it is.
    if (flags.check) {
      await page.goto(String(flags.check), { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
    const loginForm = await page.evaluate(() =>
      !!document.querySelector('input[type=password]')).catch(() => null);
    let apiStatus = null;
    if (flags.api) {
      try {
        apiStatus = await page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: "include" });
          return r.status;
        }, flags.api);
      } catch { apiStatus = "error"; }
    }
    const cookies = (await ctx.cookies()).map(c => `${c.name}${c.expires > 0 ? "" : " (session)"}`);
    const redirectedToLogin = /\/(login|signin|sign-in|auth)(\?|$)/i.test(page.url());
    // An authenticated endpoint can answer 400/404 for a signed-in user (missing params,
    // wrong shape) — only 401/403 mean "no session". Print the status either way.
    const apiAuthed = typeof apiStatus === "number" && apiStatus !== 401 && apiStatus !== 403;
    const authenticated = flags.api
      ? (apiAuthed && loginForm === false)
      : (loginForm === false && !redirectedToLogin);
    return { url: page.url(), loginForm, redirectedToLogin, apiStatus, cookies,
             authenticated: Boolean(authenticated), htmlTitle: await page.title() };
  }

  function locator({ positional, flags }) {
    if (flags.selector) return page.locator(String(flags.selector)).first();
    const m = String(positional[0] || "").match(/^([a-zA-Z]+):(.+)$/);
    if (!m) throw new Error('need "role:name" or --selector "css"');
    return page.getByRole(m[1], { name: m[2], exact: false }).first();
  }

  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      let req;
      try { req = JSON.parse(buf.split("\n")[0]); } catch { socket.end(JSON.stringify({ error: "bad request" }) + "\n"); return; }
      try {
        const fn = handlers[req.cmd];
        if (!fn) throw new Error(`unknown command ${req.cmd}`);
        const needsPage = !["start", "auth-open", "auth-wait", "close"].includes(req.cmd);
        if (!page && needsPage) throw new Error("no page: run `start <url>` first");
        const result = await fn(req);
        socket.end(JSON.stringify({ ok: true, result }) + "\n");
        if (req.cmd === "close") { server.close(); process.exit(0); }
      } catch (e) {
        socket.end(JSON.stringify({ ok: false, error: String(e.message || e).split("\n")[0] }) + "\n");
      }
    });
  });
  server.listen(SOCK);
  process.on("SIGTERM", () => process.exit(0));
}

/* ------------------------------------------------------------------ client */

function send(cmd, positional, flags, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK);
    let buf = "";
    sock.on("connect", () => sock.write(JSON.stringify({ cmd, positional, flags }) + "\n"));
    sock.on("data", (c) => { buf += c.toString(); });
    sock.on("end", () => {
      try {
        const res = JSON.parse(buf);
        if (!res.ok) return reject(new Error(res.error));
        resolve(res.result);
      } catch (e) { reject(new Error(`bad reply from daemon: ${buf.slice(0, 200)}`)); }
    });
    sock.on("error", () => reject(new Error("no browser running: run `start <url>` first")));
    sock.setTimeout(180000, () => { sock.destroy(); reject(new Error("daemon timed out")); });
  });
}

function spawnDaemon(startArgs) {
  try { rmSync(SOCK); } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start", ...startArgs, "--daemon"], {
    detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
}

async function ensureDaemon(startArgs = []) {
  try { await send("url", [], {}); return; } catch (e) {
    if (!String(e.message).includes("no browser")) return;   // daemon is up, page may be closed
  }
  spawnDaemon(startArgs);
  if (!(await waitForSocket())) fail("browser did not come up (check: npx playwright install chromium)");
}

async function waitForSocket(ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(SOCK)) {
      try { await send("url", [], {}); return true; } catch (e) {
        // A daemon that answers with an error is up; only "no browser running" means not yet.
        if (!String(e.message).includes("no browser running")) return true;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

if (isDaemon) {
  await daemon();
} else if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace("/**", ""));
} else if (cmd === "start") {
  if (!positional[0]) { console.error("start needs a URL"); process.exit(2); }
  if (typeof flags.storage === "string") {
    try {
      if (readFileSync(flags.storage, "utf8").startsWith(MAGIC)) {
        const name = flags["key-env"] || "LIVE_QA_STATE_KEY";
        if (process.env[name]) flags["key-value"] = process.env[name];
      }
    } catch {}
  }
  try { await send("close", [], {}); } catch {}
  spawnDaemon(rest);
  if (!(await waitForSocket())) { console.error("browser did not come up (check: npx playwright install chromium)"); process.exit(1); }
  try {
    const res = await send("start", positional, flags);
    console.log(JSON.stringify(res));
  } catch (e) { console.error(String(e.message)); process.exit(1); }
} else if (cmd === "auth") {
  const sub = positional[0];
  if (sub === "totp") {
    const secret = process.env[flags["secret-env"] || "LIVE_QA_TOTP_SECRET"];
    if (!secret) fail("set $LIVE_QA_TOTP_SECRET (or --secret-env NAME) to a base32 authenticator secret");
    const at = flags.at ? Number(flags.at) : Date.now();
    const code = totp(secret, at, Number(flags.digits || 6));
    console.log(JSON.stringify({ code, seconds_left: 30 - Math.floor((at / 1000) % 30), digits: Number(flags.digits || 6) }));
    process.exit(0);
  }
  const map = { login: "auth-login", probe: "auth-probe", inject: "auth-inject", state: "state",
                open: "auth-open", wait: "auth-wait", info: "auth-info", request: "auth-request" };
  const verb = map[sub] || fail(`auth needs one of: probe | login | state | inject`);
  if (["state", "auth-info"].includes(verb)) {
    const name = flags["key-env"] || "LIVE_QA_STATE_KEY";
    if (process.env[name]) flags["key-value"] = process.env[name];
  }
  if (verb === "auth-login") {
    // Credentials belong to the shell that runs the command, not to a daemon started
    // minutes earlier: resolve them here and hand them over once, in memory only.
    const pair = [[["user-env", "LIVE_QA_USER"], "user-value"],
                  [["pass-env", "LIVE_QA_PASS"], "pass-value"]];
    for (const [[flag, def], target] of pair) {
      const envName = flags[flag] || def;
      const value = process.env[envName];
      if (value) flags[target] = value;
    }
  }
  if (verb === "auth-inject") {
    // A minted token usually lives in the caller's shell, not the daemon's. Resolve it
    // here and send it once over the unix socket: it never touches disk or argv.
    for (const [flag, target] of [["cookie", "cookie-value"], ["local-storage", "local-storage-value"]]) {
      const spec = flags[flag];
      if (typeof spec === "string" && spec.includes("=")) {
        const [name, envVar] = spec.split("=");
        const value = process.env[envVar || name];
        if (!value) { console.error(`env $${envVar || name} is empty`); process.exit(2); }
        flags[target] = value;
      }
    }
  }
  try {
    if (verb === "auth-open") await ensureDaemon([]);
    const res = await send(verb, positional.slice(1), flags);
    if (res.error) { console.error(res.error); process.exit(2); }
    console.log(JSON.stringify(res, null, 1));
    process.exit(res.authenticated === false ? 2 : 0);
  } catch (e) { console.error(String(e.message)); process.exit(1); }
} else {
  try {
    const res = await send(cmd, positional, flags);
    if (res.text !== undefined) console.log(res.text);
    else if (res.links !== undefined) console.log(res.links.join("\n"));
    else if (res.value !== undefined) console.log(res.value);
    else console.log(JSON.stringify(res));
    if (cmd === "close") { try { rmSync(SOCK); } catch {} }
  } catch (e) { console.error(String(e.message)); process.exit(1); }
}
