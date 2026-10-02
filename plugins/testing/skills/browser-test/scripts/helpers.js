// Step phrasings a runner settles with plain Playwright, no model request. The generic table below is the
// vocabulary every project shares; a project adds its own in {directory}/playwright-helpers.js, and those go
// FIRST so a project can shadow a generic mapping that doesn't fit its app (a custom combobox where
// selectOption does nothing, say).
//
// The invariant the whole design rests on: a helper can only succeed or defer. It never fails a step. Anything
// that throws — element missing, name ambiguous (Playwright strict mode), timeout — returns false, and the
// caller routes that step to the model instead. A stale helper costs speed, never correctness.
//
// Check: `bun helpers-selftest.js`

import { pathToFileURL } from "url";
import { matchFirst } from "./checks.js";

const T = 3000; // per-locator ceiling; the caller caps the whole helper separately

// Nouns specs use for things you click, mapped to the ARIA role that finds them. "control", "element" and
// "item" name no role, so they fall back to the two that cover almost every clickable.
const ROLES = { button: "button", link: "link", option: "option", tab: "tab", checkbox: "checkbox",
                radio: "radio", heading: "heading", menu: "menu", menuitem: "menuitem" };
const roleOf = (noun) => (noun && ROLES[noun.toLowerCase()] ? [ROLES[noun.toLowerCase()]] : ["button", "link"]);

// Strategies are probed in order from most to least precise and the first one matching EXACTLY ONE element
// wins. count() does not auto-wait, so probing six of them is near-free — and ordering beats unioning them
// with .or(), which can only ever see the whole set: a real login form had `textbox "Password *"` next to
// `button "Show password"`, so substring matching found two and strict mode deferred every Password fill,
// where the exact label text "Password" finds one.
//
// Nothing matching exactly one is a defer, which keeps the property that matters: a name genuinely belonging
// to two elements (two different links both called "Sign in") goes to the model, which can use the context
// around them, rather than being guessed at with .first().
async function one(cands) {
  for (const loc of cands) {
    if ((await loc.count()) === 1) return loc;
  }
  return null;
}

const clickable = (page, name, noun) => [
  ...roleOf(noun).map((role) => page.getByRole(role, { name, exact: true })),
  ...roleOf(noun).map((role) => page.getByRole(role, { name })),
];
// A field is named by its label, its placeholder, or its accessible name, and specs don't say which.
//
// getByLabel and getByPlaceholder are DOM lookups and count elements that aren't displayed, so a field inside a
// collapsed section would make a fill on the visible one look ambiguous and defer. getByRole reads the
// accessibility tree, which already leaves hidden elements out.
const vis = (loc) => loc.filter({ visible: true });
const field = (page, name) => [
  vis(page.getByLabel(name, { exact: true })),
  page.getByRole("textbox", { name, exact: true }),
  vis(page.getByPlaceholder(name, { exact: true })),
  vis(page.getByLabel(name)),
  page.getByRole("textbox", { name }),
  vis(page.getByPlaceholder(name)),
];

// A step whose element isn't uniquely identifiable defers at once rather than paying a locator timeout.
async function act(cands, fn) {
  const loc = await one(cands);
  if (!loc) return false;
  await fn(loc);
  return true;
}

// The gherkin guide's one exception to quoting every value is a value that came from a `testdata:` directive,
// which specs name by role: `fill in "Email" with the test identity email`. Match that reference against the
// keys of this run's testdata, requiring every word of a key to appear in the reference — so `admin_email`
// answers "the admin manager email" but `guest_email` does not. Exactly one key may match; zero or several is a
// defer, because silently filling the wrong value is far worse than paying for a model request.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const resolve = (ctx, ref) => {
  const r = ref.toLowerCase();
  const hits = Object.entries(ctx.values ?? {}).filter(([k]) =>
    k.toLowerCase().split(/[._\s-]+/).filter(Boolean).every((tok) => new RegExp(`\\b${rx(tok)}\\b`).test(r)));
  return hits.length === 1 ? String(hits[0][1]) : undefined;
};

const url = (ctx, p) => new URL(p, ctx.base).href;
// `I am on the "Sign In" page` needs the project's route map. No entry means this helper can't answer, which is
// a defer — the model knows how to find a page by name.
const route = (ctx, name) => ctx.routes?.[name];

export const GENERIC = [
  // --- navigation ---------------------------------------------------------------------------------------
  // One entry has to cover both `"Sign In"` and `"/sessions/sign-in"`: matchFirst stops at the first matching
  // regex, so a separate path-only entry below this one would never be reached — this pattern matches those
  // steps too, and returning false here would send them to the model instead of just navigating.
  [/^I (?:am on|go to|navigate to|visit|open)(?: the)?(?: page at)? "([^"]+)"(?: page)?$/i, (page, m, ctx) => {
    const target = /^(?:\/|https?:)/.test(m[1]) ? m[1] : route(ctx, m[1]);
    return target ? page.goto(url(ctx, target), { timeout: 30_000 }) : false;
  }],
  [/^I am on the "([^"]+)" page at "(\/[^"]*)"$/i, (page, m, ctx) =>
    page.goto(url(ctx, m[2]), { timeout: 30_000 })],
  [/^the page has fully loaded$/i, (page) =>
    page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {})],

  // --- actions ------------------------------------------------------------------------------------------
  // Names are matched exactly first and then as a case-insensitive substring (see `one` above), so the loose
  // pass still absorbs the wording drift measured across the spec corpus, while the exact pass rescues a name
  // that a substring would find twice. A name belonging to two genuinely different elements defers.
  [/^I (?:click|press|tap)(?: on)?(?: the)? "([^"]+)"(?: (button|link|control|option|tab|element|item|icon))?$/i,
    (page, m) => act(clickable(page, m[1], m[2]), (loc) => loc.click({ timeout: T }))],

  [/^I (?:fill in|enter|type)(?: the)? "([^"]+)" (?:with|into|in) "([^"]*)"$/i,
    (page, m) => act(field(page, m[1]), (loc) => loc.fill(m[2], { timeout: T }))],
  [/^I (?:enter|type) "([^"]*)" (?:into|in)(?: the)? "([^"]+)"(?: field)?$/i,
    (page, m) => act(field(page, m[2]), (loc) => loc.fill(m[1], { timeout: T }))],
  // `fill in "Email" with the test identity email` — the value is a reference into this run's testdata, not a
  // literal. Unresolvable references defer rather than typing the reference text into the field.
  [/^I (?:fill in|enter|type)(?: the)? "([^"]+)" with (?!")(.+)$/i, (page, m, ctx) => {
    const value = resolve(ctx, m[2]);
    return value === undefined ? false : act(field(page, m[1]), (loc) => loc.fill(value, { timeout: T }));
  }],
  [/^I clear(?: the)? "([^"]+)"(?: field)?$/i,
    (page, m) => act(field(page, m[1]), (loc) => loc.fill("", { timeout: T }))],

  // Native <select> only. A custom combobox throws here and defers, which is the correct outcome — the
  // project shadows this entry with one that drives its own widget.
  [/^I select "([^"]+)" from(?: the)? "([^"]+)"(?: (?:dropdown|select|menu))?$/i,
    (page, m) => act([page.getByLabel(m[2], { exact: true }), page.getByRole("combobox", { name: m[2], exact: true }),
                      page.getByLabel(m[2]), page.getByRole("combobox", { name: m[2] })],
      (loc) => loc.selectOption({ label: m[1] }, { timeout: T }))],

  [/^I (check|uncheck)(?: the)? "([^"]+)"(?: (?:checkbox|toggle|switch))?$/i,
    (page, m) => act([page.getByLabel(m[2], { exact: true }), page.getByRole("checkbox", { name: m[2], exact: true }),
                      page.getByLabel(m[2]), page.getByRole("checkbox", { name: m[2] })],
      (loc) => (m[1].toLowerCase() === "check" ? loc.check({ timeout: T }) : loc.uncheck({ timeout: T })))],

  [/^I press(?: the)? "([^"]+)" key$/i, (page, m) => page.keyboard.press(m[1])],
  [/^I (?:hover over|hover on|focus)(?: the)? "([^"]+)"(?: (button|link|control|option|tab|element|item|icon|menu))?$/i,
    (page, m) => act(clickable(page, m[1], m[2]), (loc) => loc.hover({ timeout: T }))],

  // --- assertions ---------------------------------------------------------------------------------------
  // An assertion that doesn't hold throws, which defers to the model rather than failing the step. Slower on
  // a genuine failure, but a stale helper can never invent one — and genuine failures are already the slow path.
  // `heading` is in the gherkin guide's vocabulary and was missing here until a real-app run showed it as the
  // single most common step still paying for a model request.
  [/^I should see(?: the| a| an)? "([^"]+)" (button|link|control|option|tab|heading)$/i,
    (page, m) => act(clickable(page, m[1], m[2]), (loc) => loc.waitFor({ state: "visible", timeout: T }))],
  [/^I should not see(?: the| a| an)? "([^"]+)" (button|link|control|option|tab|heading)$/i,
    async (page, m) => {
      const cands = clickable(page, m[1], m[2]);
      // Nothing by that name at all, on the loosest match, is the expectation holding outright.
      if ((await cands.at(-1).count()) === 0) return true;
      // Otherwise it has to be present and hidden. Two elements sharing the name is a defer, same as anywhere.
      const loc = await one(cands);
      if (!loc) return false;
      await loc.waitFor({ state: "hidden", timeout: T });
      return true;
    }],
  [/^I should be on the "([^"]+)" page$/i, (page, m, ctx) => {
    const r = route(ctx, m[1]);
    return r ? page.waitForURL((u) => u.pathname.startsWith(r), { timeout: T }) : false;
  }],
  [/^the "([^"]+)" field should contain "([^"]*)"$/i, (page, m) =>
    act(field(page, m[1]), async (loc) => {
      const got = await loc.inputValue({ timeout: T });
      if (got.trim() !== m[2].trim()) throw new Error(`field holds "${got}"`);
    })],
];

/**
 * Settle one step with a helper, if any matches.
 *
 * @returns true when a helper matched and completed; false when nothing matched, the helper threw, or it
 *          returned false to say it can't answer. Never throws — false always means "send this to the model".
 */
export async function runStep(page, raw, ctx = {}, project = []) {
  // jev-run.js holds the keyword separately and passes the bare step; the Claude bridge passes the literal line
  // out of the .feature file. Strip it here so neither caller has to remember which.
  const step = raw.replace(/^\s*(Given|When|Then|And|But)\s+/i, "").trim();
  const hit = matchFirst([...project, ...GENERIC], step);
  if (!hit) return false;
  try {
    return (await hit[1](page, hit[0], ctx)) !== false;
  } catch {
    return false;
  }
}

/**
 * Load a project's helper table. A missing file is normal — most projects start without one.
 *
 * The cache-buster matters: Phase 2c appends helpers and re-runs inside the same process, and a plain import
 * would hand back the table from before the append.
 */
export async function loadHelpers(file) {
  if (!file) return [];
  try {
    const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
    return mod.default ?? [];
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" || e.code === "ENOENT") return [];
    console.error(`helpers: could not load ${file} — ${e.message.split("\n")[0]}`);
    return [];
  }
}
