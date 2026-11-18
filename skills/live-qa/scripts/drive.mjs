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
import { mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const of = window.fetch;
  window.fetch = async (...a) => {
    try { const r = await of(...a); if (r.status >= 400) c.failed.push({ status: r.status, url: String(a[0]).slice(0, 200) }); return r; }
    catch (e) { c.failed.push({ status: "net-error", url: String(a[0]).slice(0, 200) }); throw e; }
  };
})();
`;
const isDaemon = process.argv.includes("--daemon");

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
  let ctx, page;
  try { rmSync(SOCK); } catch {}
  mkdirSync(DIR, { recursive: true });

  const launch = async (opts) => {
    try { return await chromium.launchPersistentContext(`${DIR}/profile`, { ...opts, channel: "chrome" }); }
    catch (e) {
      const m = String(e.message);
      if (m.includes("Chromium distribution") || m.includes("Executable doesn't exist")) {
        return chromium.launchPersistentContext(`${DIR}/profile`, opts);
      }
      throw e;
    }
  };

  const handlers = {
    async start({ positional, flags }) {
      const opts = { headless: !flags.headed, viewport: { width: 1280, height: 800 } };
      if (flags.viewport) {
        const [w, h] = String(flags.viewport).split("x").map(Number);
        opts.viewport = { width: w, height: h };
      }
      ctx = await launch(opts);
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
    async close() { await ctx?.close(); return { closed: true }; },
  };

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
        if (!page && req.cmd !== "start") throw new Error("no page: run `start <url>` first");
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
  try { await send("close", [], {}); } catch {}
  try { rmSync(SOCK); } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start", ...rest, "--daemon"], {
    detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
  if (!(await waitForSocket())) { console.error("browser did not come up (check: npx playwright install chromium)"); process.exit(1); }
  try {
    const res = await send("start", positional, flags);
    console.log(JSON.stringify(res));
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
