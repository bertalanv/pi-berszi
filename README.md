# pi-spotlight

Display-only extension for [pi](https://github.com/badlogic/pi-mono) that keeps your scrollback
compact: **active** thinking and tool calls render fully and live; the moment they finish they
fold to a **single line** — thinking keeps a 3-line glimpse of the reasoning so you can tell at
a glance what it was about (no "Thought" label).

## Behavior

**Thinking**
- While a thinking run streams, pi renders it normally (full text, live).
- The moment a run settles (a text/tool block follows it, or the message finishes), it folds to
  a 3-line glimpse of the reasoning — the first lines of the thinking itself, no "Thought"
  label. The first glimpse line is clickable to re-expand the full run.
- Runs you expand are never re-folded.
- Honors the native Ctrl+T (`hideThinkingBlock`): with it on, spotlight steps back.

**Tools**
- pi's default is collapsed tool rows. Spotlight expands a row the moment its execution starts
  (full live output), then collapses it to a single header line when the result lands.
- The `edit` tool is intentionally left native: its diff is the point of the row, so it stays
  visible. (Custom self-shell tools are left native for the same reason.)
- Click the row or press Ctrl+O to re-expand; rows you touch are never re-folded.
- If you globally expand with Ctrl+O, spotlight backs off and stock behavior runs.
- Failed rows stay open so you can see the error; resumed history renders like stock pi.

Display-only: the session file, model context, and compaction are never touched.

## Install

```bash
pi install git:github.com/bertalanv/pi-spotlight
```

Then restart pi (or `/reload`).

Requires pi 1.1.0 (tested). If a future pi release changes internals, spotlight detects it,
keeps stock behavior (fail-open), and announces the degradation instead of failing.

## Usage

| Command | Effect |
|---|---|
| `/spotlight` | status |
| `/spotlight on` | enable (default) |
| `/spotlight off` | restore stock behavior |
