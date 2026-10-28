# pi-berszi

Personal [pi](https://github.com/badlogic/pi-mono) setup in one package: everything you tweak
on one machine, carried to all of them — including [pi-exa](https://github.com/junnjiee/pi-exa)
(web search) and [pi-subagents](https://github.com/nicobailon/pi-subagents) (subagent
delegation), which this package pins and pulls in automatically. Install once per machine;
change it here, commit, and `pi update --extensions` on the other machines.

## Features

| Feature | Carries | Default |
|---|---|---|
| `display` | the spotlight fold — active thinking and tool calls render fully and live; the moment they finish they fold to a single line (thinking keeps a 3-line glimpse of the reasoning) | on |
| `models` | the local `vllm` provider with the Qwen models — the model config registered in-process via `pi.registerProvider()`, so no machine-local `models.json` entry is needed or written | on |

### display

- **Thinking** — while a thinking run streams, pi renders it normally. The moment a run
  settles it folds to a 3-line glimpse of the reasoning itself (no "Thought" label); the
  first line stays clickable to re-expand the full run. Runs you expand are never re-folded.
  Honors native Ctrl+T: with it on, spotlight steps back.
- **Tools** — the moment a tool starts, its row expands and streams live output; the moment
  the result lands, the row collapses to a compact header: `⏺ bash · 0.3s` for command
  tools, `⏺ read specs/state.yaml` (path kept) for file tools. Click the row or press
  Ctrl+O to re-expand; rows you touch are never re-folded. Failed rows compact the same
  way, with a `✗` marker. The `edit` tool is left native: its diff is the point of the row.
- Display-only: the session file, model context, and compaction are never touched.

### models

- provider `vllm` at `http://100.116.35.7:8000/v1` (openai-completions, dummy key — the
  local vLLM server ignores it)

  | model | contextWindow | maxTokens | input |
  |---|---|---|---|
  | `heavy/Qwen3.8-27B-FP8` | 216064 | 65536 | text |
  | `heavy/Qwen3.8-27B-FP8-FULL` | 262144 | 24576 | text |
  | `heavy/Qwen3.8-27B-FP8-VISION` | 262144 | 24576 | text + image |

To change what the extension ships, edit `extensions/models.ts`. If a local `models.json`
also defines the provider under the same ID, both layers compose and identical entries give
an identical result — the `models.json` entry can safely be dropped once this extension is
updated everywhere.

## Bundled: pi-exa (web search) and pi-subagents (delegation)

pi-berszi ships [pi-exa](https://github.com/junnjiee/pi-exa) as a **pinned npm dependency**
(currently `0.6.1` in `package.json`), so you never install it separately. It adds Exa web
search (`web_search_exa`), fetch (`web_fetch_exa`), optional deep search (needs an Exa API
key via `/exa-login`), and its own `/exa-*` commands — no key required for the free
search/fetch tier.

It also ships [pi-subagents](https://github.com/nicobailon/pi-subagents) (currently
`0.83.1` in `package.json`), so the subagent delegation tools, their skills, and prompts
load with the same install — no separate `npm:pi-subagents` package entry needed.

Updates are manual, your call:

1. Check the latest version: `npm view pi-exa version` / `npm view pi-subagents version`
   (compare with the pins in `package.json`)
2. If you want it: bump the pin in `package.json`, commit, push
3. `pi update --extensions` on each machine — when the repo moves, pi re-resolves the
   dependency and the new package version is picked up automatically

While a pin is unchanged, `pi update` never touches that package.

## Commands

| Command | Effect |
|---|---|
| `/berszi` | status of all features |
| `/berszi on` / `/berszi off` | all features |
| `/berszi display on` \| `off` | the display fold |
| `/berszi models on` \| `off` | the bundled models |

Toggles persist to `~/.pi/agent/berszi-state.json`, so they survive restarts and
`/reload`. Delete that file to reset to the defaults.

## Add a feature

1. Create `extensions/<name>.ts` exporting:

   ```ts
   import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

   export const myFeature = {
       name: "myfeature",
       description: "one line about what this carries",
       enable(pi: ExtensionAPI): boolean { /* … */ return true; },
       disable(pi: ExtensionAPI): boolean { /* … */ return true; },
       attached(): boolean { /* … */ return true; },
   };
   ```

2. Import it and add it to `FEATURES` in `extensions/index.ts`.

Status, on/off toggles, and persistence come for free.

## Install / update

```bash
pi install git:github.com/bertalanv/pi-berszi   # once, per machine — pulls in pi-exa + pi-subagents too
pi update --extensions                            # after pushing changes here
```

One install line is the whole ritual. Then restart pi (or `/reload`).

Requires pi 1.1.0 (tested). If a future pi release changes internals, a feature that cannot
attach keeps stock behavior (fail-open) and announces the degradation instead of failing.
