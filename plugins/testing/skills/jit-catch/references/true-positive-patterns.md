# True Positive Patterns for Elixir

These patterns, adapted from Table 3 of "Just-in-Time Catching Test Generation at Meta" (2026), are the most reliable signals that a diff has introduced an unintended behavioral change. Each pattern is tuned for Elixir idioms.

## `unexpected_key_change`

A map or struct key is accessed (via `Map.get`, `map.key`, or pattern matching) but the diff changed or removed that key without updating all access points.

**Elixir signals:**
- `KeyError` or `MatchError` in code paths not touched by the diff
- Struct field added/removed but not all `%MyStruct{}` patterns updated
- Map key renamed in one place but accessed by old name elsewhere

## `empty_collection`

A list, map, or MapSet becomes empty in scenarios where it previously had elements, despite the diff not explicitly clearing it.

**Elixir signals:**
- `Enum.map/2` or `Enum.filter/2` returning `[]` when it previously returned results
- A query returning an empty list due to changed conditions
- `Map.new/0` or `%{}` replacing a populated map without clear intent

## `changed_return_tuple`

A function's return value changes shape — typically `{:ok, value}` becoming `{:error, reason}`, a bare value, or vice versa — without all callers being updated.

**Elixir signals:**
- `case` or `with` clauses in callers that no longer match
- `{:ok, _} = Module.function()` assertions that would now fail
- Pipe chains where the next function expects the old return shape

## `nil_value`

A value becomes `nil` in contexts where it wasn't `nil` before, and the `nil` wasn't introduced by the diff directly.

**Elixir signals:**
- `Map.get/2` returning `nil` for a key that was removed or renamed
- Function returning `nil` instead of a default value after a code path change
- `NilError` or `** (UndefinedFunctionError) ... nil.function` in untouched code paths

## `pattern_match_failure`

Existing pattern matches fail because the data shape changed in the diff, but the pattern match site wasn't updated.

**Elixir signals:**
- `MatchError` on `=` bindings
- `FunctionClauseError` when no clause matches
- `CaseClauseError` or `CondClauseError` for unhandled new cases

## `monotonic_change`

The diff intends to only add new behavior (a new feature, logging, telemetry) but inadvertently changes existing behavior.

**Elixir signals:**
- A function's return value changes because a new expression was added as the last line
- A side effect (like `Logger.info`) placed in a position that changes what the block returns
- Adding a new `def` clause that matches before an existing clause due to Elixir's top-down clause matching

## `refactor_side_effect`

A refactoring that should be meaning-preserving (extracting a function, renaming, reorganizing modules) but subtly changes behavior.

**Elixir signals:**
- Extracted function doesn't preserve all arguments or default values
- Module rename breaks `apply/3` or string-based module references
- Moving code between modules changes `__MODULE__` references
- Reorganizing `with` chains changes error handling behavior
- `import`/`alias` changes that cause name resolution to shift
