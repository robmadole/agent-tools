# Gherkin Guide for Browser Testing

## Syntax Primer

Gherkin is a structured language for describing software behavior in plain English. Each `.feature` file describes a single feature with one or more scenarios.

### File Structure

```gherkin
Feature: Short feature description
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
  Managers should be able to sign in with their email and password
  to access the management dashboard.

  Background:
    Given I am on the "Sign In" page

  Scenario: Successful sign-in with valid credentials
    When I fill in "Email" with "manager@example.com"
    And I fill in "Password" with "password"
    And I click the "Sign in" button
    Then I should be on the "Dashboard" page
    And I should see "Acme Corp"

  Scenario: Failed sign-in with wrong password
    When I fill in "Email" with "manager@example.com"
    And I fill in "Password" with "wrongpassword"
    And I click the "Sign in" button
    Then I should see "Invalid email or password"
    And I should be on the "Sign In" page

  Scenario: Failed sign-in with empty fields
    When I click the "Sign in" button
    Then I should see "Email" field should have an error
    And the "Password" field should have an error
```
