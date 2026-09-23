Feature: Fixture sign-in and settings

  A self-contained page for checking the Jev runner end to end.
  Run with --values '{"password":"password"}'.

  Background:
    Given I am on the "Sign In" page

  Scenario: Successful sign-in
    When I fill in "Email" with "user@example.com"
    And I fill in "Password" with the password
    And I click the "Sign in" button
    Then I should see "Welcome back"
    And I should see the "Dashboard" heading

  Scenario: Wrong password shows an error
    When I fill in "Email" with "user@example.com"
    And I fill in "Password" with "wrongpassword"
    And I click the "Sign in" button
    Then I should see "Invalid email or password"
    And I should not see "Welcome back"

  Scenario: Save settings after signing in
    Given I am signed in as "user@example.com"
    When I select "Pro" from the "Plan" dropdown
    And I check the "Agree to terms" checkbox
    And I click the "Save" button
    Then I should see "Settings saved: Pro"

  Scenario Outline: Empty fields are rejected
    When I fill in "Email" with "<email>"
    And I click the "Sign in" button
    Then I should see "Invalid email or password"

    Examples:
      | email            |
      | user@example.com |
      | nobody@test.dev  |

  # Expected to fail: the page never shows "Welcome back" without valid credentials.
  Scenario: Deliberate failure
    When I click the "Sign in" button
    Then I should see "Welcome back"
