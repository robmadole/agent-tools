# Gherkin Guide for Browser Testing

## Syntax Primer

Gherkin is a structured language for describing software behavior in plain English. Each `.feature` file describes a single feature with one or more scenarios.

### File Structure

```gherkin
Feature: Short feature description
  testdata: create location "Test Camp" --with-admin

  Optional multi-line description of the feature.
  Can span several lines.

  Background:
    Given some common precondition

  Scenario: Descriptive scenario name
    Given a precondition
    When an action is taken
    Then an expected outcome occurs

  Scenario Outline: Parameterized scenario
    Given I am on the "<page>" page
    When I enter "<value>" into the "<field>" field
    Then I should see "<result>"

    Examples:
      | page  | field    | value      | result          |
      | login | email    | user@ex.co | Welcome         |
      | login | email    | invalid    | Invalid email   |
```

### testdata Directives

Every feature file **must** declare its test data requirements using `testdata:` lines in the feature description (after the `Feature:` keyword, indented with 2 spaces). These lines tell the test harness what data to create before running scenarios.

#### Syntax

Each `testdata:` line contains a command (without any tool/mix prefix). Later lines can reference `$variable_name` values from earlier command outputs using variable interpolation. A blank line separates the directives from the rest of the feature description.

```gherkin
Feature: Guest reservation booking
  testdata: create location "Test Camp" --with-admin
  testdata: create booking-season $location_id
  testdata: create base-price $location_id
  testdata: create charging-policy $location_id

  Description of the feature goes here.
```

#### When to use which pattern

| Pattern | When to use |
|---------|-------------|
| `testdata: exemplar default` | Tests that need a fully populated location with site groups, sites, images, and multiple manager roles. Most management UI tests (tables, filters, images, navigation). |
| `testdata: create location "Name" --with-admin` | Tests that only need a location and an admin manager. Simpler tests like sign-in, error states, permissions. |
| `testdata: create location "Name" --with-admin` + chained commands | Tests that need reservation infrastructure (booking seasons, pricing, charging policies) — typically guest-facing reservation flows. |
| `testdata: create guest` | Tests that need a standalone guest account (not tied to a reservation). |

#### Chained commands with variable references

The JSON output from each command is flattened into a variable scope. Top-level keys become `$key_name` variables for subsequent lines.

```gherkin
Feature: Guest info page for authenticated guests
  testdata: create location "Test Camp" --with-admin
  testdata: create booking-season $location_id
  testdata: create base-price $location_id
  testdata: create charging-policy $location_id
  testdata: create guest

  An authenticated guest should see a full reservation summary.
```

#### Choosing the right test data

Think about what each scenario **actually needs**:

- **Viewing/managing site groups, images, tables, filters?** → `exemplar default` (needs populated data)
- **Sign-in, sign-out, error redirects?** → `create location` with `--with-admin` (just needs credentials)
- **Guest reservation flows?** → `create location` + booking-season + base-price + charging-policy (needs pricing infrastructure)
- **Guest account behavior?** → Add `create guest` for a standalone guest account

### Keywords

- **Feature**: One per file, names the capability being tested
- **Background**: Steps shared by every scenario in the file (runs before each)
- **Scenario**: A single test case with a descriptive name
- **Scenario Outline** + **Examples**: A parameterized scenario run once per row
- **Given**: Establishes preconditions (navigation, state setup)
- **When**: Describes the action being tested
- **Then**: Describes the expected outcome
- **And** / **But**: Continues the previous Given/When/Then

## Step Phrasing Conventions for Browser Testing

Use these standard step patterns for consistency across specs.

### Quote every value

Put every value a step types, selects, or looks for in double quotes: field values, option labels, element names, and expected text. A runner should never have to make up a value or guess what counts as a match.

- **Inputs:** `When I fill in "Email Address" with "nobody@example.com"`, not `When I enter invalid credentials`.
- **Expected text:** `Then I should see "That was an invalid email or password"`, not `Then I should see an error message indicating invalid credentials`.
- **Deep links:** quote the path when the page has no obvious name: `Given I am on the "/search?q=coffee" page`.

The one exception is a value that comes from `testdata:` output. Refer to it by its role, e.g. `with the admin manager email`, and the runner resolves it from the test data block.

### Write specs the Jev runner can settle

A project can run specs with the Jev runner, a fast model that picks from what's on the page and never has to interpret a step. Specs written this way cost Claude runners nothing and let Jev finish them without falling back to Claude:

- **One action per step.** Put the submit in its own step: `And I press the "Enter" key` or `And I click the "Sign In" button`.
- **Name the account.** Use `Given I am signed in as "free@example.com" with password "password"`, not `Given I am signed in as a free user`.
- **Use current element names.** Use the element's accessible name as the page shows it, quoted.
- **Prefer these exact phrasings.** Jev checks them in code, with no judgment involved:
  - `I should see "X"` and `I should not see "X"`
  - `the URL should contain "X"` and `the page title should be "X"`
  - `I wait for N seconds`, `I scroll to the "X" section`
- **Assert what's on the page.** Say what the page shows (`Then I should see "Signing In…"`), not how it looks (`the button should show a loading state`).
  - Expectations about colors, layout, HTML attributes, or a state that only lasts while a request is in flight always go to a Claude runner. Write them only when that's really what's being tested.

### Assume two people are on the page

Every feature that touches a surface where one person's action changes what another person is
already looking at **must say what the second person sees**. Either write a scenario with
`actors:`, or put a line in the Feature description saying why one viewer is the whole story —
a read-only page, a single-user flow, a form only its author can see.

A shared record open on two screens is the ordinary case for anything a team operates: two
people at a front desk, a manager and a supervisor, the same person on a laptop and a phone. A
suite where every scenario has exactly one viewer tests a product nobody runs.

#### Declaring the actors

`actors:` is a directive beside `testdata:` — two-space indented, in the feature description,
before the prose. It names them in order, and each name gets its own browser with its own
cookie jar.

```gherkin
Feature: Two managers race the same check-in
  testdata: create location "Front Desk Camp" --with-admin
  testdata: create manager $location_id --role=admin --email=dana@test.local
  testdata: create manager $location_id --role=admin --email=sam@test.local
  actors: Dana, Sam
```

Name them after people, not roles. `actors: Dana, Sam` reads; `actors: manager_1, manager_2` is
a variable name wearing a hat, and in a report filmstrip you cannot tell which screen you are
looking at.

#### Handing over the keyboard

One new step phrasing, and it is the only one:

```gherkin
Given Dana is at the keyboard
When Sam is at the keyboard
```

Every step after it belongs to that actor, until the next handoff. **`I` always means whoever is
at the keyboard**, so every other phrasing in this guide works unchanged — there is no
actor-prefixed twin of `When I click the "Save" button` to learn or to write.

Sign each actor in with ordinary steps, in `Background`, so it lands in the step record and the
filmstrip:

```gherkin
  Background:
    Given Dana is at the keyboard
    And I am signed in as "dana@test.local" with password "password"
    And I am on the "Calendar" page
    And Sam is at the keyboard
    And I am signed in as "sam@test.local" with password "password"
    And I am on the "Calendar" page
```

#### Rules that keep a two-actor spec honest

- **Quote each actor's own account.** Where test data creates them, two commands of the same
  kind emit the same JSON keys and the variable scope is flat, so the second silently wins
  `$email`. Pin each one with an explicit flag and refer to that address.
- **The other actor's screen changes a beat later.** A push over a websocket, a poll, a
  re-render — none of it is synchronous with the first actor's click. An assertion made right
  after a handoff is allowed to retry for up to ~15 seconds before failing.
- **Say what the second person sees, not that nothing broke.** `Then I should see` the new state
  is the test; the absence of an error is not.
- **Order the handoffs deliberately, and say why in the prose.** Which actor opened the dialog
  first is usually the whole test. A reader who cannot tell why the handoffs fall where they do
  cannot repair the spec when it breaks.
- Three actors work the same way and cost a third browser. Two is almost always the test.

### Navigation (Given)

```gherkin
Given I am on the "Sign In" page
Given I am signed in as "admin@example.com"
Given I am signed in as "admin@example.com" with password "password"
Given the page has fully loaded
```

### Interactions (When)

```gherkin
When I click the "Submit" button
When I click the "Dashboard" link
When I click the "Delete" icon
When I fill in "Email" with "user@example.com"
When I select "Monthly" from the "Billing" dropdown
When I check the "Agree to terms" checkbox
When I uncheck the "Subscribe" checkbox
When I press the "Enter" key
When I scroll to the "Footer" section
When I hover over the "Profile" menu
When I wait for 2 seconds
When I clear the "Search" field
```

### Assertions (Then)

```gherkin
Then I should see "Welcome back"
Then I should see the "Dashboard" heading
Then I should not see "Error"
Then the "Email" field should contain "user@example.com"
Then the "Submit" button should be disabled
Then the "Submit" button should be enabled
Then the "Subscribe" checkbox should be checked
Then the "Subscribe" checkbox should be unchecked
Then I should be on the "Dashboard" page
Then the URL should contain "/dashboard"
Then I should see 5 "reservation" items
Then the "Name" field should have an error
Then the page title should be "My App - Dashboard"
```

## Category Directory Naming

Organize specs into short category directories under `{directory}/specs/`:

| Directory | Scope |
|-----------|-------|
| `sign-in/`       | Authentication, sign-in, sign-out, password reset |
| `navigation/`    | Navigation, menus, breadcrumbs, routing |
| `user-profile/`  | User profiles, account settings, preferences |
| `calendar/`      | Calendar, scheduling, date pickers |
| `app-settings/`  | Application settings, configuration panels |
| `site-manage/`   | Sites, locations, property management |
| `reservations/`  | Reservations, bookings, availability |
| `dashboard/`     | Dashboard, overview pages, widgets |
| `form-input/`    | Form interactions, validation, submission |
| `data-tables/`   | Tables, lists, sorting, filtering, pagination |
| `notifications/` | Notifications, alerts, toasts, banners |
| `error-states/`  | Error pages, error states, fallback UI |

Choose the most specific category. If a spec crosses categories, use the primary one.

## Anti-Patterns to Avoid

### Vague scenario names
Bad: `Scenario: Test the page`
Good: `Scenario: Admin can create a new reservation from the calendar view`

### Implementation details in steps
Bad: `When I click the element with CSS selector "#btn-submit"`
Good: `When I click the "Submit" button`

### Multiple actions in one step
Bad: `When I fill in the form and click submit`
Good: Two separate steps — one for filling, one for clicking

### Unquoted values
Bad: `Given I am on the "Sign In" page and enter invalid credentials`
Good: `When I fill in "Email Address" with "nobody@example.com"` then `And I fill in "Password" with "wrong-password"`

### Missing Given context
Bad: Starting a scenario with `When I click "Delete"`
Good: Establish where the user is and what state exists first

### Overly long scenarios
Keep scenarios under 10-12 steps. If longer, break into multiple scenarios or use Background for shared setup.

### Testing implementation instead of behavior
Bad: `Then the div.alert-success should be visible`
Good: `Then I should see "Reservation created successfully"`

### Brittle assertions on exact counts or text
Bad: `Then I should see exactly "Showing 1-10 of 247 results"`
Good: `Then I should see "results"` or `Then I should see at least 1 "result" item`

## Example Feature File

```gherkin
Feature: Manager sign-in
  testdata: create location "Test Camp" --with-admin

  Managers should be able to sign in with their email and password
  to access the management dashboard.

  Background:
    Given I am on the "Sign In" page

  Scenario: Successful sign-in with valid credentials
    When I fill in "Email" with the admin manager email
    And I fill in "Password" with "password"
    And I click the "Sign in" button
    Then I should be on the "Dashboard" page
    And I should see "Test Camp"

  Scenario: Failed sign-in with wrong password
    When I fill in "Email" with the admin manager email
    And I fill in "Password" with "wrongpassword"
    And I click the "Sign in" button
    Then I should see "Invalid email or password"
    And I should be on the "Sign In" page

  Scenario: Failed sign-in with empty fields
    When I click the "Sign in" button
    Then I should see "Email" field should have an error
    And the "Password" field should have an error
```
