# Streaming rendering performance

Validated on 2026-10-07 with Solid 2.0.0-rc.13 / @solidjs/web 2.0.0-rc.13.
The implementation follows the installed `solid-js/skills/reactivity-diagnostics/SKILL.md`
and `solid-js/CHEATSHEET.md`, including compute/apply effects, intentional `untrack`
snapshots, custom-keyed `For` accessors, and settled DOM measurement.

## Rendering boundaries

- Session descriptors invalidate on `structureVersion`, not text/progress mutations.
  Stable groups contain at most eight turn keys or work steps to bound subscription width.
- A turn is a sequence of stable work and text segments. Starting a text block closes the
  preceding work segment; later tools create a new segment. The existing text component
  stays mounted when an intermediate reply becomes a final answer or vice versa.
- Automatic work folding immediately releases the work subtree; user-triggered folding
  keeps its short animation. The response boundary resets the live segment's manual
  override once. Completed segments can still be expanded by the user.
- Store deltas coalesce per block per animation frame. Structural events first commit
  pending deltas in the same transaction. Per-fragment sequence numbers allow snapshots
  to cover only part of a batch without duplication or loss. A 100ms fallback also commits
  data when a hidden browser suspends animation frames.
- Closed Markdown prefixes are parsed once. A plain active paragraph updates a stable
  text node; structured tails patch sanitized DOM. A slow tail draw lowers the painting
  frequency after a 4ms budget overrun. Final text catches up immediately. Checkpoint
  replacement resets closed content, including empty replacements.
- The thinking line reads only the active reasoning block, scans at most 800 trailing
  characters and displays at most 200. Switching blocks clears stale text.
- Diff virtualization measures settled DOM, invalidates on row-count changes, caches
  horizontal width, and preserves an unchanged visible range.
- Pagination merges adjacent gaps and changes store slots in place rather than repeatedly
  shifting entire observable arrays.

## Reproduce

Start Vite in one PowerShell terminal:

```powershell
pnpm exec vite --host 127.0.0.1 --port 5173
```

Then run in another terminal, without editing source while the benchmark is running:

```powershell
$env:QAQH_ONLY='boot,rate300,rate900,checkpoint,thinking,realign,tableStream,progressSmall,expand,toTop,toBottom,layout'
$env:QAQH_CDP_PORT='9425'
$env:QAQH_REPORT='docs/streaming-performance.json'
$env:QAQH_GPU='0'
$env:QAQH_ASSERT='1'
node scripts/stress-cdp.mjs
```

The script launches an isolated headless Edge profile. `QAQH_EDGE` overrides its path;
`STRESS_URL` overrides the fixture URL. `QAQH_GPU=1` allows GPU use, but is not proof of
hardware acceleration. The fixture uses the real store and UI with synthetic transport.

Assertions fail the process for missing/incorrect text, lost text-component identity,
unexpected reopening of old work, a rate-test frame interval over 50ms, incorrect
checkpoints/thinking, incomplete table rows, or collected browser/framework diagnostics.
Type and unit checks remain separate:

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
```

## Recorded result

See `streaming-performance.json` for the full environment and raw results. Edge was
154.0.4258.53, headless, GPU disabled. Each synthetic token is four Chinese characters,
delivered as one event; batches arrive every 10ms. Both rate scenarios span six seconds
of input, with additional mounting and final-settlement time.

| Scenario | Input | Frame interval P95 | Maximum interval | Frames >50ms |
| --- | --- | ---: | ---: | ---: |
| Streaming reply | 300 tokens/s, 1,800 tokens | 18.2ms | 19.8ms | 0 |
| Streaming reply | 900 tokens/s, 5,400 tokens | 18.2ms | 32.7ms | 0 |
| Thinking line | 90,000 characters in 3 seconds | 18.3ms | 19.4ms | 0 |
| Growing GFM table | 200 data rows plus header | 28.8ms | 37.5ms | 0 |

Both rate tests lost zero characters, rendered exact text, preserved the first reply
element through subsequent tool/reply boundaries, and kept prior work collapsed.
The observed plain paragraph added one child and removed none. Neither rate test
recorded a streaming long task. Thinking reset and cleared correctly. The table ended
with all 201 rows. Browser/framework diagnostics were empty, and assertions passed.
After historical paging and eviction, 50 turns plus one gap remained. Layout checks
found no horizontal-overflow offenders or zero-height turns.

## Limits and glass design budget

These measurements cover frontend synthetic streaming, not the model tokenizer,
real Rust IPC, network backpressure, or every WebView2/GPU/monitor combination. Cold
fixture setup did record long tasks (319ms and 80ms); this work does not establish a
cold-start guarantee. Growing structured Markdown costs more than plain text: the
table paints can be throttled to roughly 120ms intervals and its frame P95 is above
a 60Hz budget. Bounded DOM mutation does not make parsing an ever-growing table free.
The next heavy-Markdown improvement would be parsing/patching only appended rows or
moving parsing off the main thread, with syntax-boundary correctness tests.

The Liquid Glass concept is not installed by this change, so this report does not
claim to validate its GPU/compositing cost. When implementing it:

- Keep blur on a small, fixed bottom navigation surface. Message text, thinking text,
  tool output, and scrolling history should use ordinary opaque/translucent surfaces.
- Share the glass material through UI tokens; avoid per-message filters, nested blur,
  continuously animated noise, and pointer-following refraction.
- Animate navigation transforms/opacity rather than blur radius or content height.
  Reserve bottom inset space so a floating tab bar never overlays the composer.
- Offer a solid-material/reduced-motion mode. Determine adaptive degradation from
  measured frame cost rather than an assumed device model.
- Repeat these correctness gates and test actual GPU compositing in WebView2 with
  glass enabled, at the target refresh rate. A software headless result is a baseline,
  not a guarantee of the finished glass design.
