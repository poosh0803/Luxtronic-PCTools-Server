---
name: unit-testing
description: How to write and extend unit tests in this repo (Luxtronic PCTools Server). Use this any time you're adding test coverage for a new or existing module in src/ — including when GPU/RAM/SSD support gets added alongside the current CPU-only code, or when touching src/lib/, src/config.js, or any other pure-logic module. Also use it before deciding a piece of code "can't really be unit tested" — this skill defines exactly what counts as in-scope for this suite and what belongs in manual/integration testing instead. Covers the test runner, style, fixture patterns, and what NOT to test here.
---

# Unit testing in Luxtronic-PCTools-Server

This repo's test suite (`test/*.test.js`, run via `npm test`) has a specific, deliberate shape. It's not the only valid way to write tests — it's the way *this* codebase has consistently done it across every module so far (`auth`, `concurrency`, `config`, `resultComputation`, `testRunCache`, `validation`), and staying consistent matters more here than optimizing any single test file in isolation. Read one or two existing files in `test/` before writing a new one — they're the real spec, this document just explains the reasoning so you can apply it to code that doesn't have an existing test file to copy from yet.

## Runner and dependencies

Node's built-in test runner: `node --test` + `node:assert/strict`. No Jest, Mocha, Chai, Sinon, or any other test-framework dependency — `package.json`'s `devDependencies` has zero testing packages, and that's intentional, not an oversight. This is a small internal tool; the built-in runner does everything this suite needs, and every added dependency is one more thing to patch/audit/upgrade later for no real benefit. Don't reach for a mocking library either — if you feel like you need one, that's usually a sign the thing you're testing belongs in "out of scope" below, not a sign to add Sinon.

## Style

Flat `test('description', () => { ... })` calls. No `describe()` blocks — this codebase doesn't nest. Test names read as a full sentence describing the behavior, not a fragment:

```js
test('loadConfig throws a clear error if the concurrency section is missing', () => { ... });
test('isValidUuid: rejects a UUID missing a segment', () => { ... });
```

For a predicate or helper with several valid/invalid cases, prefer one table-driven test over many near-duplicate ones — loop over an array of cases with `assert.equal(fn(v), expected, \`message including ${v}\`)` so a failure tells you *which* case broke without re-running anything. See `test/validation.test.js` for the pattern.

## Scope: what belongs in this suite

Unit-test **pure, deterministic logic only** — the parts of a module whose output depends only on its inputs. That's the fast/cheap category `npm test` should stay in forever: it currently runs in well under a second with no network, DB, or file locks to manage. In this codebase that means:

- Pure functions and predicates (`src/lib/validation.js`, `src/lib/concurrency.js`, `src/lib/resultComputation.js`)
- Deterministic transforms (`src/lib/auth.js`'s `hashApiKey` — same input always produces the same output)
- File-based config/parsing logic, tested against real temp files rather than mocked `fs` (see Fixtures below)
- The parts of a stateful module that don't require its external dependency — e.g. `src/lib/testRunCache.js`'s `set()`/`remove()`/cache-*hit* path of `get()` are plain `Map` operations and testable with zero DB setup; its cache-*miss* path calls `pool.query()` and is correctly left untested here

## Scope: what does NOT belong in this suite

Do not write tests here that need a live Postgres connection, a running Express server, or a real WebSocket connection. This has been confirmed as the intentional boundary twice now by separate people extending this suite — it's not an oversight to "get to later." Concretely, that means `src/lib/pdf.js`, the route handlers in `src/routes/*.js`, and the WebSocket handlers in `src/ws/*.js` are out of scope for `test/*.test.js`. If you need confidence that those work, that's an end-to-end/manual check (curl, a throwaway script, the browser) — a genuinely different activity from what this suite is for, with different setup costs and different failure modes. Keep them separate; don't blur the line by reaching for a DB-backed integration test just because a module is otherwise hard to unit-test — see "if it's not pure, extract the pure part" below instead.

## Fixture pattern for disk I/O

When a module reads from disk (the shape `src/config.js` has), don't mock `fs`. Write real temp fixture files instead:

```js
function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luxtronic-<thing>-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
```

If the module reads its path from an env var (like `CONFIG_PATH`), wrap the mutation so it's always restored, even on failure — otherwise one test can leak state into every test file that runs after it in the same process:

```js
function withConfigPath(filePath, fn) {
  const original = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = filePath;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = original;
  }
}
```

See `test/config.test.js` for the full working version of both helpers, including the test that proves the config loader re-reads from disk on every call rather than caching stale content — that test mutates the fixture file *between* two calls in the same test, which is the kind of thing a mock would hide.

## Boundary and edge cases earn an explicit test

When logic has a threshold (a value compared against a configured limit, a value at the edge of a valid set), write a test that pins down what happens *exactly at* the boundary — not just comfortably above and below it. `test/resultComputation.test.js` has paired tests for a value landing exactly on a `max_*` limit and exactly on a `min_*` limit (both currently resolve to `flagged`, not `fail`/`pass`). The point isn't that this particular behavior is the only correct choice — it's that boundary behavior is exactly the kind of thing that silently flips during an unrelated refactor if nothing asserts it. Write the test for whatever the current, intentional behavior actually is.

## If the logic you need to test isn't pure yet

Some modules mix pure decision logic with I/O or state in the same function. Rather than skip testing it, or reaching for a mock/integration test, extract the pure part into its own function in the same module and test that directly — no new file, no new indirection layer, just a second `function` and a `module.exports` entry. (The C# client repo in this project uses an `internal` visibility trick for the equivalent move; that's a workaround for C#'s stricter access model and doesn't apply here — a plain exported function is already the right level of privacy for a Node module, since anything not exported is already inaccessible outside the file.) This is exactly the kind of change worth doing *as part of* adding test coverage, not a separate refactoring task to defer.

## Commits

One logical unit of new test coverage per commit — e.g. "Add unit tests for API key hashing (src/lib/auth.js)", not one giant commit adding five unrelated test files. Check `git log` for the exact tone before writing a message; it's been consistent (imperative mood, names the file/module being covered) across every test-adding commit so far.

## Before you start

1. Read the module you're about to test in full — don't assume its behavior from the function name.
2. Skim one existing test file that's testing something structurally similar (a predicate → `validation.test.js`, disk I/O → `config.test.js`, a cache → `testRunCache.test.js`) and match its shape.
3. Decide, module by module, which parts are pure (test them) and which need Postgres/HTTP/WS (leave them, per Scope above) — don't treat a whole file as untestable just because part of it isn't pure.
4. Run `npm test` before committing and confirm the new tests actually fail if you temporarily break the logic they're checking — a test that can't fail isn't testing anything.
