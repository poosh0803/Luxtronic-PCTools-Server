**RESOLVED (server side):** `statTiles()` (`public/js/session.js`) and `pdf.js`'s summary table
now render `min_seq_read_mb_s`/`min_seq_write_mb_s` as "Sequential Read"/"Sequential Write" with
an " MB/s" suffix, everything else unchanged (small manual label/unit map, not a general system,
per the ask below). Verified against the real session this note references
(`1ebba806-4878-464d-b6de-34d50631331b`) on the live production dashboard and its PDF export --
"Sequential Read 3131.72 MB/s" / "Sequential Write 61.84 MB/s" both render correctly.

# Note from the client side: SSD benchmark test (DiskSpd) now wired up

Status: **live-verified end-to-end against the real running server** (2026-08-15) - technician ran
a real SSD benchmark through the app, session/test_run showed up correctly on the dashboard at
`192.168.68.255:7777`, `result` computed as expected. So the "no server code changes required"
claim below is now confirmed, not just reasoned about. **One concrete, actionable ask below** ("Please
add MB/s units/nicer labels to the SSD throughput stat tiles") - the rest of this doc is
background/context, most of it now just historical.

## Requested: nicer display for the SSD throughput numbers

Real dashboard screenshot from the verification run showed the stat tiles rendering exactly as
raw key/value pairs - `MIN_SEQ_READ_MB_S` / `3131.72`, `MIN_SEQ_WRITE_MB_S` / `61.84` - same as
every other component's tiles, no units, no friendly label. The user explicitly asked for this to
be nicer ("display the speed"). This is a `statTiles()` (`public/js/session.js`) /
`pdf.js` rendering change, not a data-shape change - the client isn't sending anything different,
just asking for these two specific keys to render better. Left unimplemented by me deliberately -
it's your rendering code, not mine to touch.

Suggested minimal approach (adjust to match your existing conventions, this is just a shape, not a
mandate): in `statTiles()`, special-case `min_seq_read_mb_s`/`min_seq_write_mb_s` (or generically,
any key ending `_mb_s`) to render the value with a `" MB/s"` suffix and a friendlier label than the
raw upper-cased key - e.g. `"Sequential Read"` / `"Sequential Write"` instead of
`"MIN_SEQ_READ_MB_S"`. Same idea applies to `pdf.js`'s summary_stats table if it has the same raw
rendering. Not asking for a general "pretty units for every stat" system - just these two, since
they're the ones a technician actually reads at a glance to judge the benchmark. If you'd rather
build a small generic label/unit map instead (since other stats like `max_smart_temp_c` could
arguably want the same "°C" treatment later) that's fine too - your call either way.

## FYI, client-side bug found and fixed during this same verification (no server action needed)

The first real run got flagged `result: aborted` / `stop_reason: tool_crash` even though both
DiskSpd passes printed complete, valid throughput numbers - turned out to be a client-side bug
(DiskSpd exited with a non-standard non-zero code despite fully valid output; the client was
trusting the raw exit code over the actually-parsed results). Fixed client-side to trust parsed
output over exit code. Purely FYI in case you noticed an `aborted` SSD test_run from that first
run sitting in the DB - that one row is stale/real but the bug behind it is fixed now.

---

Everything below is the original note from before live verification - kept for context, mostly
superseded by the "Status" line above.

## What changed client-side

The SSD test was previously just a disabled "coming soon" checkbox plus a passive, telemetry-free
SMART-only report submitted automatically after every CPU run (see
`SSD_SMART_ADDENDUM.md` in the shared planning repo - still accurate, unchanged). This adds a real
technician-initiated SSD benchmark: pick a drive from a picker, click Start, get real sequential
read/write throughput numbers.

CrystalDiskMark's own GUI (`DiskMark64.exe`) turned out to have **zero CLI/automation surface**
(confirmed by scanning the binary directly - no autostart/silent/headless/cmdline/csv/export
capability exists anywhere in it). Instead of UI-automating that GUI, the client wraps **DiskSpd**
directly - Microsoft's MIT-licensed benchmark engine that CrystalDiskMark bundles and uses
internally for its own numbers (`tools/CrystalDiskMark/CdmResource/DiskSpd/DiskSpd64.exe`).
Reproduces CDM's flagship "SEQ1M Q8T1" test (1 MiB blocks, queue depth 8, unbuffered I/O) as two
passes against a scratch file in a technician-chosen folder - never a raw device, per
PROJECT_PLAN.md's no-destructive-testing constraint - deleted afterward.

## Why I don't think anything needs to change here

Checked directly rather than assuming:

- **`isValidComponent`/concurrency/`computeResult`** (`src/lib/validation.js`,
  `src/lib/concurrency.js`, `src/lib/resultComputation.js`) are already fully component-agnostic -
  `ssd` is already a first-class component everywhere, already in `exclusive_components`, and
  `computeResult`'s `max_`/`min_` prefix-matching convention needs no special-casing for a new kind
  of `ssd` test_run.
- **`config/default.json`'s `ssd` subtree already has exactly the keys this benchmark populates**:
  `min_seq_read_mb_s`, `min_seq_write_mb_s` (new, from this benchmark) plus `max_smart_temp_c`,
  `max_smart_reallocated_sectors`, `max_smart_percentage_used`, `min_smart_available_spare_percent`,
  `max_smart_media_errors` (already there, already used by the existing passive SMART reports -
  this benchmark's test_run reuses the same `SsdSmartReader.BuildSummaryStats` keys, just merged
  with the two new throughput keys into one `summary_stats` object instead of a separate passive
  report).
- **Dashboard (`public/js/session.js`'s `statTiles`) and PDF (`src/lib/pdf.js`)** both render
  `summary_stats` generically as raw key/value pairs - no `ssd`-specific formatting exists to
  update. (Optional future polish, not required: `min_seq_read_mb_s`/`min_seq_write_mb_s` currently
  render as bare numbers with no "MB/s" unit suffix, same as every other stat tile - not asking for
  this, just flagging it in case you want nicer units later.)

## One doc-drift bug found and fixed (informational only - your copy was already correct)

Both the shared planning repo's `CONTRACT.md` and this client repo's own `CONTRACT.md` still had
the *stale* §3 `ssd` example (`"smart_reallocated_sectors_max": 0` - "max" as a suffix) even though
`resultComputation.js`'s own comments and *this* server repo's `CONTRACT.md` already documented the
fix (`max_smart_reallocated_sectors` etc., prefix-based) from whenever that was originally caught.
I synced both stale copies to match your already-correct version (including your explanatory
paragraph about the naming-bug history) - no action needed on your side, just flagging in case it
was surprising to see those files touched by the client agent.

## What arrives over the wire for this new test_run type

Same `component: "ssd"` flow as the existing passive reports (`POST .../test-runs` →
`PATCH .../test-runs/:id`), just with a fuller `summary_stats`:

```jsonc
{
  "error_count": 0,                 // always 0 for this test type - DiskSpd failures surface as stop_reason=tool_crash instead
  "min_seq_read_mb_s": 2104.65,     // new - actual measured throughput, absent if that pass was stopped early
  "min_seq_write_mb_s": 68.2,       // new - same
  "max_smart_temp_c": 44.0,         // pre-existing SMART key, re-read fresh right after the benchmark
  // + whichever other max_smart_*/min_smart_* keys apply to that drive's bus type, same as before
}
```

`tool_output_raw` now includes DiskSpd's raw stdout (both passes) followed by a formatted SMART
snapshot - free text, not meant to be parsed server-side, same convention as every other
component's `tool_output_raw`.

Happy to answer questions if anything here doesn't match what you're seeing once a real run comes
through - this note is a snapshot of my reasoning, not a guarantee nothing was missed.
