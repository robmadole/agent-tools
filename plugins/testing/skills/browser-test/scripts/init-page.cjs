// Preloads the step helpers onto every Playwright MCP page, so the Claude runner settles a step by running the
// SAME function jev-run.js runs rather than a transcription of it.
//
// Wired up in the plugin's .mcp.json:
//   --init-page=${CLAUDE_PLUGIN_ROOT}/skills/browser-test/scripts/init-page.cjs
//
// The MCP server requires this file in its own Node process, once per tab, and calls the default export with the
// live page object (playwright-core: `const { default: func } = require(initPage); await func({ page })`). That
// object is the same one browser_run_code_unsafe is handed, so a property set here is there later:
//
//   async (page) => page.__runStep('When I click the "Save" button', { base, values })
//     -> true  the step is done, no snapshot and no exploring
//     -> false nothing matched or it didn't resolve; drive the step the normal way
//
// CommonJS on purpose: the server calls require() on this path, and require() of an ES module only works on newer
// Node. The real (ESM) helpers come in through a dynamic import below, which works everywhere.
//
// NOTHING HERE MAY THROW. The server wraps this call and re-throws as "Failed to load init page", which fails tab
// initialization — a dead browser for the whole session, on every tool call, with an error that points at this
// file and not at the project config that actually broke. A bridge that fails to load must degrade to "no
// bridge", never to "no browser".

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// The project root is normally the server's cwd, the same place --output-dir=./browser-tests/tmp resolves
// against. Reading the project's own config from it is what lets one .mcp.json line serve every project without
// knowing anything about them. A session started somewhere else (a home directory, a notes folder) has a cwd with
// no .browser-tests.json, so callers can also pass `root` in the ctx of a __runStep call and the bridge reloads
// the config and helpers from there.
function projectConfig(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".browser-tests.json"), "utf8"));
  } catch {
    return {};
  }
}

async function loadProject(helpers, root) {
  const cfg = projectConfig(root);
  const routes = cfg.jev?.routes ?? {};
  // Re-read per tab, so helpers written mid-session (a subagent gets a fresh tab) are picked up without
  // restarting the session.
  const file = path.resolve(root, cfg.directory ?? "browser-tests", "playwright-helpers.js");
  const project = await helpers.loadHelpers(file);
  // A file that is present but contributed nothing is a typo, not a choice, and it fails silently otherwise:
  // every step keeps working, just slowly, and nobody finds out for a whole run.
  const broken = project.length === 0 && fs.existsSync(file)
    ? `${file} loaded no helpers — check it for a syntax error or a missing default export`
    : null;
  return { root, config: fs.existsSync(path.join(root, ".browser-tests.json")), routes, project, broken };
}

module.exports = {
  default: async ({ page }) => {
    // A bridge that isn't there is a normal state, not an error: it means every step takes the route it took
    // before this existed. Set the stub first so an exception below still leaves a callable function.
    page.__runStep = async () => false;
    page.__helpers = { loaded: false, project: 0, reason: null };
    try {
      const helpers = await import(pathToFileURL(path.join(__dirname, "helpers.js")).href);
      let state = await loadProject(helpers, path.resolve("."));
      const report = () => {
        page.__helpers = { loaded: true, root: state.root, config: state.config, project: state.project.length,
          generic: helpers.GENERIC.length, reason: state.broken };
      };

      page.__runStep = async (raw, ctx = {}) => {
        try {
          const { root, ...rest } = ctx;
          if (root && path.resolve(root) !== state.root) {
            state = await loadProject(helpers, path.resolve(root));
            report();
          }
          // An empty step only (re)loads the project, so a caller can point the bridge at a root and read
          // page.__helpers without running anything.
          if (!raw) return false;
          // Per-call ctx carries the values this run's testdata: directives actually produced — the Claude
          // fallback runs after a fresh testdata pass, so they are not the ones the Jev pass used. Routes come
          // from the project config and a caller can still override them.
          return await helpers.runStep(page, raw, { routes: state.routes, ...rest }, state.project);
        } catch {
          return false;
        }
      };
      report();
    } catch (e) {
      page.__helpers = { loaded: false, project: 0, reason: String(e && e.message).split("\n")[0] };
    }
  },
};
