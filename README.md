# pi-spotlight

Display-only extension for [pi](https://github.com/badlogic/pi-mono) that keeps your scrollback
compact: **active** thinking and tool calls render fully and live; the moment they finish they
fold to a **single line**.

## Behavior

**Thinking**
- While a thinking run streams, pi renders it normally (full text, live).
- The moment a run settles (a text/tool block follows it, or the message finishes), it folds to
  one `Thought` line.
- Click the line to re-expand that run; runs you expand are never re-folded.
- Honors the native Ctrl+T (`hideThinkingBlock`): with it on, spotlight steps back.

**Tools**
- pi's default is collapsed tool rows. Spotlight expands a row the moment its execution starts
  (full live output), then collapses it to a single header line when the result lands.
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
