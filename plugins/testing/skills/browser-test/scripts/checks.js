// Assertion phrasings the runner settles in code, with no Jev request. Split out of jev-run.js so they can
// be tested without launching a browser.

export const fold = (s) => s.toLowerCase().replace(/\s+/g, " ");
export const decode = (u) => {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
};

// Exact lookups stay in code instead of going to Jev. Each says whether the expectation holds right now and how to
// describe a miss. Text is case- and whitespace-folded, since CSS text-transform changes innerText.
export const LITERAL_CHECKS = [
  [/^I should (not )?see "([^"]+)"$/i, (m, obs) => {
    const seen = fold(obs.text).includes(fold(m[2]));
    return { ok: seen !== Boolean(m[1]), miss: `"${m[2]}" is ${seen ? "" : "not "}on the page` };
  }],
  [/^the URL should (not )?contain "([^"]+)"$/i, (m, obs) => {
    const has = obs.url.includes(m[2]) || decode(obs.url).includes(m[2]);
    return { ok: has !== Boolean(m[1]), miss: `the URL ${obs.url} ${has ? "contains" : "does not contain"} "${m[2]}"` };
  }],
  [/^the page title should be "([^"]+)"$/i, (m, obs) => ({ ok: obs.title === m[1], miss: `the page title is "${obs.title}"` })],
  // The snapshot marks only the non-default state — `button "Save" [disabled]`, `checkbox "X" [checked]` — so an
  // absent flag is the answer, not missing information. Jev reads that absence poorly (0.55 on a plainly enabled
  // button), and it can't: nothing in the state says "no flag here means enabled".
  [/^the "([^"]+)" (button|checkbox|field|link|option) should be (enabled|disabled|checked|unchecked)$/i, (m, obs) => {
    const want = m[3].toLowerCase();
    const flag = want === "enabled" || want === "disabled" ? "disabled" : "checked";
    const roles = { button: ["button"], checkbox: ["checkbox"], link: ["link"], option: ["option"] }[m[2].toLowerCase()];
    // ponytail: first name match, role-filtered where the noun names one. Ambiguous names would need the ref.
    const node = obs.nodes.find((n) => fold(n.name) === fold(m[1]) && (!roles || roles.includes(n.role)));
    if (!node) return { ok: false, miss: `no ${m[2]} named "${m[1]}" is on the page` };
    const has = node.flags.some((f) => f.startsWith(`[${flag}`));
    return { ok: has === (want === "disabled" || want === "checked"),
             miss: `the "${m[1]}" ${m[2]} is ${has ? "" : "not "}${flag}` };
  }],
];

// Known phrasings that need no judgment; code runs them directly.
export const CODE_STEPS = [
  // ponytail: a fixed sleep becomes "wait up to N seconds for the network to settle"; the action loop and assertion
  // polling already wait for state.
  [/^I wait for (\d+(?:\.\d+)?) seconds?$/i, (page, m) => page.waitForLoadState("networkidle", { timeout: m[1] * 1000 }).catch(() => {})],
  [/^I scroll to the "([^"]+)" section$/i, (page, m) => page.getByText(m[1]).first().scrollIntoViewIfNeeded({ timeout: 5000 })],
  [/^I resize the browser to (?:a )?mobile viewport$/i, (page) => page.setViewportSize({ width: 390, height: 844 })],
];

export const matchFirst = (table, raw) => table.map(([re, fn]) => [raw.match(re), fn]).find(([m]) => m);
