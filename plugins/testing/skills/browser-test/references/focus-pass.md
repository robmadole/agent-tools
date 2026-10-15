## Focus pass

This is a **focus pass**. The functional pass already ran these scenarios and settled their verdicts. You run
them again, the same way, and at each transition you also run the focus checks below. Two things come out of
it: findings about how the app treats people the functional specs don't think about, and a second, independent
attempt at every scenario.

### Run the scenarios exactly as usual

Drive and record every step as Step 1 describes, helper bridge included. Your `{report command}` already
carries `--pass focus`, so these records never touch the functional verdict. Assert `Then` steps honestly: a
`Then` that fails here when it passed before is the whole reason this pass doubles as a flake check, so
don't wave one through because "it passed last time", and don't fail one to be thorough.

Run each scenario **once**. If a step fails, record it as failed and move on. Don't run the flow again with
new data until it passes, don't retry a step, and don't fold a `When` and the `Then` after it into one action
so the assertion lands in time. Every one of those hides the inconsistency this pass exists to find. A step
that fails here and passed in the functional pass is a result, not a problem to fix.

On a **failed** step, and only then, screenshot before recording, and add `--screenshot` to the record:

- `{playwright tool prefix}browser_take_screenshot` with `type: "png"`, `scale: "css"`, and
  `filename: "{focus dir}/<slug>-<n>.png"`

`<slug>` and `<n>` work as in the functional pass. The orchestrator compares this frame against the functional
one to decide whether the scenario is flaky.

### Transitions

A transition is a step that changes what the page is: a `Given` that lands somewhere, or a `When` that
navigates, submits, opens or closes something. Background steps count. `Then` steps only observe, so they are
never transitions.

After each transition **that passed**, run every focus's checks against the state it reached. Run them
after the `Then` (and `And`/`But`) steps that directly follow the transition, not between the transition and
those steps. Axe plus four widths takes seconds, and a `Then` that asserts a toast or a short-lived message
fails if the checks run first. That is a false failure the checks caused. So: run the transition, run and
record its `Then` steps, then run the checks, then the next `When` or `Given`. The `Then` steps only observe,
so the page is still the state the transition reached. Skip a transition when:

- the step failed — the page is not in the state the spec is about
- you already checked the same state in this feature: same URL path, and nothing new is open (no new dialog,
  menu, panel, banner or error). Keep a short list as you go. Filling a field is usually not a new state;
  submitting the form usually is.

### Leave the page exactly as you found it

The next step runs against whatever you leave behind. Every check below that emulates, resizes or moves focus
says how to undo it. Do the undo **before** the next step, even when the check threw. A step that fails because
a check left the page at 320px wide is a false failure, and false failures here read as flakes.

### Recording findings

Record each problem you find with one Bash call, as with steps:

```bash
{finding command} --focus accessibility --scenario 'Sign in with valid credentials' --step 'When I click the "Sign in" button' --rule focus-not-moved --impact serious --summary 'Focus stays on the submit button after the error appears' --source judgment --url 'http://localhost:4000/sign-in'
```

- `--step` is the transition the problem was seen after, as the .feature file spells it.
- `--rule` is a short kebab-case id. Use the ones each focus lists, spelled exactly as listed, or axe's own
  rule id for something axe names. Findings group by rule id, so `dialog-unnamed` next to `dialog-name` is the
  same problem reported twice. Invent one only when nothing listed covers it, and say so in `difficulties`.
- `--source` is `axe` for what axe reported, `measurement` for a number a focus snippet measured (overflow,
  target size), and `judgment` for your own call.
- `--impact` is one of axe-core's four levels, for every focus:
  - `critical` — blocks the task outright for some people
  - `serious` — a real barrier: possible, but only with effort or a workaround
  - `moderate` — friction, or a barrier on a secondary path
  - `minor` — polish
- Add `--target '<css selector>'` when the problem belongs to one element. Findings with the same rule and
  target group across pages, so spell it the same way every time: copy it verbatim from what the snippet or
  axe printed, and for your own findings use the shortest selector that picks the element out
  (`header .wa-cluster`, not `body > div.app-container > header.app-container > div.wa-cluster`).
- Add `--detail '<what you saw>'` when the summary needs evidence, and `--screenshot {focus dir}/<file>.png` when a picture shows it.
- Same quoting rules as `record`: single quotes, one call per Bash call, no chaining.

Record findings only on the app's own origin, the one in the base URL. A sign-in that goes through a
separate identity provider, or a payment page, is someone else's page even when the scenario passes through
it. Say once in `difficulties` which other origins you skipped.

Findings never fail a step and never change a verdict. Don't fix anything, and don't report a problem twice on
the same state: the report already groups repeats across transitions.

### Budget

The checks below are a pass over each new state, not an audit of the whole app. If a state is plainly the same
template as one you checked (a second record in the same list view), say so in `difficulties` and skip it.
