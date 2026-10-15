---
name: responsive
label: Responsive design
description: "Every new state at 320, 375, 768 and 1280px, plus a phone render with touch: overflow, clipping, tiny targets, layouts that fall apart."
---

## Responsive design

At each transition, the page is re-laid-out at four widths without leaving it. Chrome's device emulation
changes the viewport in place, so the state the scenario reached (an open dialog, a filled form, an error)
is still there at every width. The measurements catch the mechanical failures. The screenshots are for
what only looking catches.

### At each transition

**1. Measure and capture.** One call. It resizes to each width, measures, screenshots, does a phone render,
and restores the original viewport even if something throws. Replace `SHOTS` with
`{focus dir}/<slug>-<n>` before running it. `{focus dir}` is absolute, and it has to be: `page.screenshot`
resolves a relative path against the MCP server's working directory, not the project.

```
{playwright tool prefix}browser_run_code_unsafe with code:
async (page) => {
  const SHOTS = "SHOTS";
  page.__cdp ??= await page.context().newCDPSession(page);
  const measure = () => {
    const d = document.documentElement, vw = d.clientWidth;
    // Web components draw their own controls inside shadow roots, which querySelectorAll doesn't enter. A 16px
    // remove button inside a tag component was invisible to this until it walked into them.
    const deep = (root) => [...root.querySelectorAll("*")].flatMap((e) => e.shadowRoot ? [e, ...deep(e.shadowRoot)] : [e]);
    const up = (e) => e.parentElement ?? e.getRootNode().host ?? null;
    const own = (e) => e.id ? `#${e.id}` : e.tagName.toLowerCase() + (e.classList[0] ? "." + e.classList[0] : "");
    const sel = (e) => { const h = e.getRootNode().host; return h ? `${sel(h)} ${own(e)}` : own(e); };
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
    // Content inside a scroller (a wide table in overflow-x: auto) is allowed to be wide.
    const scrolls = (e) => { for (let p = up(e); p && p !== document.body; p = up(p)) { if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX)) return true; } return false; };
    const all = deep(document.body).filter(shown);
    const wide = all.filter((e) => e.getBoundingClientRect().right > vw + 1 && !scrolls(e));
    const outermost = wide.filter((e) => !wide.includes(up(e)));
    // Skip anything under 3px wide: that's a visually-hidden screen reader span, clipped on purpose.
    const clipped = all.filter((e) => e.getBoundingClientRect().width > 2 && e.scrollWidth > e.clientWidth + 1 && /hidden|clip/.test(getComputedStyle(e).overflowX)
      && e.textContent.trim() && getComputedStyle(e).textOverflow !== "ellipsis");
    const targets = all.filter((e) => e.matches('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')).map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width < 24 && r.height < 24);
    return {
      overflow: d.scrollWidth > vw ? `${d.scrollWidth}px content in ${vw}px` : null,
      wide: outermost.slice(0, 5).map((e) => `${sel(e)} reaches ${Math.round(e.getBoundingClientRect().right)}px`),
      clipped: clipped.slice(0, 5).map(sel),
      small_targets: targets.slice(0, 8).map(([e, r]) => `${sel(e)} ${Math.round(r.width)}x${Math.round(r.height)}`),
    };
  };
  const out = {};
  // viewportSize() is null when the browser has no fixed viewport (it tracks the window). Playwright can't go back
  // to that, so pin the size the page had instead.
  const orig = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  try {
    for (const width of [320, 375, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(200);
      out[width] = await page.evaluate(measure);
      await page.screenshot({ path: `${SHOTS}-${width}.png`, scale: "css" });
    }
    // Mobile emulation is only for reading the layout width. page.screenshot() re-applies Playwright's own
    // viewport, which undoes a CDP override, so the phone frame is taken at a plain 390x844 instead.
    await page.__cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await page.__cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await page.waitForTimeout(200);
    out.phone = await page.evaluate(() => ({
      layout_width: innerWidth,
      viewport_meta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    }));
    await page.__cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.__cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}-phone.png`, scale: "css" });
  } finally {
    await page.__cdp.send("Emulation.clearDeviceMetricsOverride");
    await page.__cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.setViewportSize(orig);
  }
  out.restored = await page.evaluate(() => innerWidth);
  return out;
}
```

Widths go through `page.setViewportSize`, not a CDP override: `page.screenshot()` re-applies Playwright's
viewport for the capture, so a CDP width measures right but photographs at desktop width. The phone's mobile
emulation still goes through `page.__cdp`. A CDP override belongs to the session that set it: a fresh session
can't clear what an earlier one set, and the page would stay at 390px for the rest of the scenario.

`restored` is the width the page is back at. If it isn't the width the scenario started at, say so in
`difficulties`.

**2. Look.** Read `SHOTS-320.png` and `SHOTS-768.png` every time. Read `-375`, `-1280` and `-phone` when
the measurements flagged that width or the 320 frame looks off. The functional pass already saw the page
at the default desktop width.

**3. Record** what's wrong. Measurement-backed problems first, with `--source measurement`, then what the
screenshots show, with `--source judgment`. Put the measured element in `--target`: one element with the same
problem on several pages groups into one finding, so a shared header is reported once however many pages show it.

| Rule | Evidence | What's wrong |
|---|---|---|
| `horizontal-overflow` | `overflow` set at a width | the page scrolls sideways. Name the `wide` element as `--target` |
| `viewport-zoomed-out` | `phone.layout_width` isn't 390 | Chrome zoomed out to fit the page on a phone. Either `viewport_meta` is missing, or overflow forced it. Text renders tiny |
| `target-too-small` | `small_targets` at 320 or 375 | a control smaller than 24px both ways (WCAG 2.5.8). A control under 24px in one direction only usually passes on spacing, so the measurement leaves it out. Links inside a sentence are exempt, so judge from the screenshot |
| `content-clipped` | `clipped` at a width | text cut off by `overflow: hidden` with no ellipsis or other way to reach it |
| `content-overlap` | screenshot | elements drawn on top of each other: a header over content, a button over text |
| `content-unreachable` | screenshot | something the scenario used is gone at this width with no way to get to it (nav hidden, no menu button) |
| `layout-unusable` | screenshot | technically no overflow, but it doesn't work: a three-word-wide column, a form that needs the side-scroller of a table, a dialog taller than the screen with no scroll |

Attach the screenshot of the width that shows it with `--screenshot`, and put the width in the summary
("Header covers the first form field at 320px").

**Nothing to undo.** The snippet restores the viewport in its `finally`. If it returned an error instead of
the measurements, run the two `Emulation.clear…`/`setTouchEmulationEnabled` lines and
`page.setViewportSize(<the original size>)` on their own before the next step.

### What this focus can't tell you

This is Chromium emulating a phone, not a phone. iOS Safari quirks (the `100vh` toolbar, input zoom on
focus, `position: fixed` with the keyboard up) don't show up here. Don't claim them either way.
