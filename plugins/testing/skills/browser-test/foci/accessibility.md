---
name: accessibility
label: Accessibility
description: "axe-core's WCAG rules at every transition, plus the judgment calls it can't make: focus, announcements, meaningful names, keyboard reach."
---

## Accessibility

Two halves. axe-core does the mechanical rules: contrast math, missing names, ARIA misuse. You do what a rule
engine can't: where focus went after the step, whether a message is announced, whether a name actually means
something. Don't re-check what axe already checks; spend your attention on the second half.

### Before the first step of each scenario

axe goes into the page as a script, and a strict Content-Security-Policy blocks that. Turn CSP enforcement off
for this tab before anything navigates. It only affects this test browser, and it has to come before the page
loads to take effect:

```
{playwright tool prefix}browser_run_code_unsafe with code:
async (page) => {
  page.__cdp ??= await page.context().newCDPSession(page);
  await page.__cdp.send("Page.setBypassCSP", { enabled: true });
  return true;
}
```

Always go through `page.__cdp`. A CDP override belongs to the session that set it: a fresh session can't see or
clear what an earlier one set.

### Before each `When` step

Messages that come and go (a toast, a status line that clears itself) are often gone by the time you look,
and a component's screen reader announcer can be removed in under a second. So before each `When` step,
start a recorder that writes down every live-region text that appears:

```
{playwright tool prefix}browser_evaluate with function:
() => {
  const q = '[role="status"],[role="alert"],[aria-live]:not([aria-live="off"])';
  const kind = (e) => e.getAttribute("role") || `aria-live=${e.getAttribute("aria-live")}`;
  const seen = new Set([...document.querySelectorAll(q)].map((e) => kind(e) + ":" + e.textContent.trim()));
  window.__announced = [];
  window.__announcer?.disconnect();
  window.__announcer = new MutationObserver(() => {
    for (const e of document.querySelectorAll(q)) {
      const t = e.textContent.trim(), k = kind(e) + ":" + t;
      if (t && !seen.has(k)) { seen.add(k); window.__announced.push({ live: kind(e), text: t.slice(0, 200) }); }
    }
  });
  window.__announcer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  return true;
}
```

Read it back with `() => window.__announced` once the step has settled, and judge announcements only from
that read. Settled means the URL has stopped changing and the page shows the step's result. The step helper
waits for that itself. When you drove the step by hand, check `page.url()` or the snapshot first, and use
`browser_wait_for` with a second or two if the result isn't there yet. A LiveView or SPA navigation swaps the
page without a load, and a read taken before the swap is a read of the page being left. Before recording
`status-not-announced`, read the list once more, right before the next `When` resets it: a late announcement
still counts. That list is what a screen reader was given. It only sees the light DOM, so an announcer inside a shadow root doesn't show up
there; check the snapshot before calling one missing. A full page load drops the recorder, which is fine:
nothing from the old page is announced after it.

### At each transition

**1. axe.** Inject it if the page doesn't have it yet. Every full navigation drops it:

```
{playwright tool prefix}browser_run_code_unsafe with code:
async (page) => {
  if (await page.evaluate(() => typeof axe === "undefined")) await page.addScriptTag({ path: "{axe path}" });
  return true;
}
```

Run it and write the result to a file, not into your context:

```
{playwright tool prefix}browser_evaluate with
  function: () => axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }).then((r) => ({ url: r.url, violations: r.violations, incomplete: r.incomplete }))
  filename: {focus dir}/<slug>-<n>-axe.json
```

WCAG tags only. axe's best-practice rules (`region` and friends) were most of the noise when this was
tried, and they aren't failures of anything.

When the dispatch is about one component on a page that isn't (a dev page showing a single form input), scope
axe to it: pass `{ include: [["<css selector>"]] }` as the first argument instead of `document`.

axe reads every stylesheet, and on some sites that shows up as console 404s for `@import`ed stylesheet paths
while it runs. That is axe fetching stylesheets, not the app. Don't record it, and don't count it as a console
error in the scenario.

Record it in one call. The command reads axe's result as-is:

```bash
{finding command} --focus accessibility --source axe --scenario '<scenario>' --step '<transition step>' --from {focus dir}/<slug>-<n>-axe.json
```

It prints `incomplete`: the checks axe couldn't decide, usually contrast over an image or gradient. Judge
each one. Take a screenshot of the element if you need to see it. Record the real ones yourself with
`--source judgment` and axe's rule id (`color-contrast`). Drop the rest.

`incomplete_dropped` counts the ones already dropped for you: contrast inside a shadow root, and
`aria-controls`/`aria-owns` pointing into one. axe stops at shadow roots, so it can't decide those, and on a
web-component app they were most of the list and never real. If a component's contrast looks wrong in the
screenshot, judge it yourself as above.

**2. Your checks.** Do the ones the transition makes relevant. Use `browser_snapshot` for roles, names and
state, and `browser_evaluate` for where focus is. Follow it into shadow roots, because on a web-component app
`document.activeElement` is only the host:
`() => { let e = document.activeElement; while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement; return e?.outerHTML.slice(0, 200); }`.

| Rule | Check when | What's wrong |
|---|---|---|
| `focus-not-moved` | a step opened a dialog, menu or panel, or navigated without a page load | focus stayed behind on the trigger or fell to `<body>` |
| `focus-not-trapped` | a modal dialog is open | Tab ~10 times with `browser_press_key`: focus escapes the dialog to the page behind it. A native `showModal()` dialog's Tab cycle passes through `<body>` on its way out to the browser's own controls and back. That is the browser, not an escape. Only an element of the page behind counts |
| `focus-not-returned` | a step closed a dialog or menu | focus went to `<body>` instead of back to what opened it |
| `focus-not-visible` | you Tabbed anywhere above | the focused element looks no different. Wait ~200ms after the Tab, so a focus ring that animates in has arrived, then screenshot it focused. Decide from the picture, not from `outline: none`: plenty of sites draw focus with a shadow or background |
| `focus-obscured` | you Tabbed anywhere above | the focused element is entirely hidden behind something the page drew over it: a sticky header, a cookie banner (WCAG 2.4.11) |
| `status-not-announced` | a step produced an error, success or status message | its text isn't in `window.__announced`, isn't in a live region now, and focus didn't move to it. Check the recorder first: a toast that has already gone may well have been announced |
| `error-not-associated` | a form shows field errors | the field doesn't point at its error (`aria-describedby`, `aria-errormessage`) or isn't `aria-invalid` |
| `error-not-identified` | a form rejected input | nothing says which field is wrong or what's wrong with it: only a red border, or a generic "something went wrong" (WCAG 3.3.1) |
| `dialog-name` | a dialog is open | the dialog has no accessible name in the snapshot (`dialog ""`). Check the element with `role="dialog"` or the `<dialog>` itself, inside the component's shadow root if there is one |
| `landmark-main` | a new page, once | there's no `main` landmark in the snapshot, so a screen reader user can't jump past the header and nav (WCAG 2.4.1) |
| `timing-adjustable` | a message or session that times out | something the user has to read or act on disappears or expires on a timer, with no way to pause, extend or get it back (WCAG 2.2.1). A toast whose text is also somewhere lasting doesn't count |
| `name-not-meaningful` | a new state appeared | a control's accessible name exists but says nothing: "click here", "button", "x", an icon's file name, `alt="image"`, two links with the same name going different places |
| `keyboard-unreachable` | a new page, once | something clickable (a `div` with a handler, `cursor: pointer`) never takes focus when you Tab through the page (up to ~25 stops) |
| `motion-not-reduced` | a new page with animation, once | with `browser_emulate_media` `reducedMotion: "reduce"`, `document.getAnimations().length` is still above 0 for decorative motion |
| `color-only-meaning` | status is shown by color (red/green badges, required fields) | nothing but the color carries it. Check the snapshot for text or an icon name |

**Undo before the next step:**

- If you Tabbed, put focus back. Before the first Tab, remember where it was. Follow focus into shadow roots,
  because focusing a component's host can land on a different element inside it:
  `() => { let e = document.activeElement; while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement; window.__focusRestore = e; }`.
  After the last one, return it:
  ```
  () => {
    const e = window.__focusRestore;
    delete window.__focusRestore;
    if (e && e !== document.body && e.isConnected) return e.focus();
    // Focus started on <body>, and body.focus() does nothing. Blurring alone also leaves Chrome's Tab starting
    // point where Tabbing stopped, so park focus on a throwaway element at the top of the page first.
    const t = Object.assign(document.createElement("span"), { tabIndex: -1 });
    document.body.prepend(t); t.focus(); t.blur(); t.remove();
  }
  ```
  Skip the Tab checks when the next step presses a key without naming an element. It acts on whatever has focus.
- Stop the recorder after reading it: `() => window.__announcer?.disconnect()`.
- If you emulated media, clear it with `browser_emulate_media` and `reducedMotion: null`.
- Never press Escape, Enter or Space to test something. Those change state the next step depends on.

### What this focus can't tell you

There's no screen reader in this browser. The accessibility tree is what a screen reader would be given, not
what it says. Don't claim "VoiceOver announces …". Say what the tree has.
