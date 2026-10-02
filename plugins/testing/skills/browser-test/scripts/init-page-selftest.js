#!/usr/bin/env bun
// Self-check for init-page.cjs, driving a real @playwright/mcp server over stdio.
// Run: bun scripts/init-page-selftest.js        (needs network for npx, and Chrome)
//
// The invariant this exists for: init-page.cjs runs inside the MCP server's tab initialization, and the server
// turns any throw from it into "Failed to load init page" — which fails EVERY tool call for the rest of the
// session. A broken project helpers file must cost the project its helpers, never its browser. Case B below is
// the whole reason this file exists; the rest is there to prove the bridge actually carries a step.

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

const INIT = path.join(import.meta.dir, "init-page.cjs");
const PORT = 8937;
const FIXTURE = `http://127.0.0.1:${PORT}/app.html`;

// Serve the fixture: the MCP server blocks file:// URLs unless --allow-unrestricted-file-access is passed.
const server = Bun.serve({
  port: PORT,
  fetch: () => new Response(fs.readFileSync(path.join(import.meta.dir, "jev-fixture", "app.html")),
    { headers: { "content-type": "text/html" } }),
});

function project(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `initpage-${name}-`));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return dir;
}

// A minimal MCP stdio client — enough to initialize, navigate, and run code.
function client(cwd) {
  const srv = spawn("npx", ["@playwright/mcp@latest", "--isolated", "--headless", "--init-page", INIT],
    { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", id = 0;
  const waiting = new Map();
  srv.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      } catch {}
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    waiting.set(n, res);
    setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), 120_000);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  return {
    srv,
    async start() {
      await send("initialize",
        { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "1" } });
      srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args }),
    // browser_run_code_unsafe returns its value as JSON inside a "### Result" block.
    async evaluate(code) {
      const r = await send("tools/call", { name: "browser_run_code_unsafe", arguments: { code } });
      const text = r.result?.content?.map((c) => c.text).join("\n") ?? "";
      const m = text.match(/### Result\n([\s\S]*?)(?:\n### |$)/);
      return m ? JSON.parse(m[1]) : { error: text.slice(0, 300) };
    },
    stop: () => srv.kill(),
  };
}

const HELPERS = `export default [
  [/^I sign in as the fixture user$/i, async (page, m, ctx) => {
    await page.getByLabel("Email").fill(ctx.values.email);
    await page.getByLabel("Password").fill("password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(() => document.title === "Dashboard", null, { timeout: 3000 });
  }],
];`;

const CASES = [
  {
    name: "A  valid config and project helpers",
    files: { ".browser-tests.json": '{"directory":"browser-tests"}', "browser-tests/playwright-helpers.js": HELPERS },
    expect: { loaded: true, project: 1, reason: null },
    projectHelperRuns: true,
  },
  {
    name: "B  project helpers file is broken",
    files: { ".browser-tests.json": '{"directory":"browser-tests"}',
             "browser-tests/playwright-helpers.js": "export default [ not valid javascript ===" },
    expect: { loaded: true, project: 0 },
    reasonMentionsFile: true,
    projectHelperRuns: false,
  },
  {
    name: "C  no .browser-tests.json at all",
    files: {},
    expect: { loaded: true, project: 0, reason: null },
    projectHelperRuns: false,
  },
];

let n = 0;
for (const c of CASES) {
  const cwd = project(c.name[0], c.files);
  const mcp = client(cwd);
  try {
    await mcp.start();
    const nav = await mcp.call("browser_navigate", { url: FIXTURE });
    // The load-bearing one: whatever is wrong with the project, the browser still works.
    assert.ok(!nav.error && !nav.result?.isError, `${c.name}: browser unusable — init-page broke tab init`);
    n++;

    const info = await mcp.evaluate("async (page) => page.__helpers");
    for (const [k, v] of Object.entries(c.expect)) {
      assert.strictEqual(info[k], v, `${c.name}: __helpers.${k} was ${JSON.stringify(info[k])}, wanted ${JSON.stringify(v)}`);
    }
    if (c.reasonMentionsFile) {
      assert.ok(info.reason?.includes("playwright-helpers.js"),
        `${c.name}: a present-but-unloadable helpers file must say so, got ${JSON.stringify(info.reason)}`);
      n++;
    }
    assert.ok(info.generic > 0, `${c.name}: generic helpers are always available`);
    n++;

    const out = await mcp.evaluate(`async (page) => ({
      project: await page.__runStep('Given I sign in as the fixture user', { values: { email: 'user@example.com' } }),
      generic: await page.__runStep('When I fill in "Email" with "a@b.c"', {}),
      unmapped: await page.__runStep('When I do something nobody mapped', {}),
      missing: await page.__runStep('When I click the "Nowhere" button', {}),
      title: await page.title() })`);
    assert.strictEqual(out.project, c.projectHelperRuns, `${c.name}: project helper ran?`);
    assert.strictEqual(out.title, c.projectHelperRuns ? "Dashboard" : "Sign In", `${c.name}: page state after helper`);
    // Both must defer, in every case — this is the same contract jev-run.js relies on.
    assert.strictEqual(out.unmapped, false, `${c.name}: an unmapped step defers`);
    assert.strictEqual(out.missing, false, `${c.name}: a missing element defers`);
    n += 4;
    console.log(`  ok  ${c.name}`);
  } finally {
    mcp.stop();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

server.stop();
console.log(`\ninit-page-selftest: ${n} checks passed`);
