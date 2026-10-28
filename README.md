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
| `exa` | the `mcpUseApiKey` flag in pi-exa's `pi-exa.json` — with it on, `web_search_exa` / `web_fetch_exa` connect to the Exa MCP with your stored key (paid tier) instead of keyless (anonymous free tier + its rate limit) | on |
| `chime` | macOS system sounds for backgrounded sessions: **Glass** when the agent settles (waiting for your input), **Ping** when pi shows a question or confirmation. No-op on non-mac machines (reads "on", stays silent) | on |

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

### exa

pi-exa's MCP tools connect to the remote Exa MCP **without your key by default** —
keyless, Exa serves the anonymous free tier and its low rate limit. (The direct-SDK
tool `deep_search_exa` was never affected: it always reads the stored key.)

This feature covers both halves, and defaults both to **on**:

- **The flag** — it sets `mcpUseApiKey` in `~/.pi/agent/pi-exa.json`, preserving every
  other pi-exa config field. `/exa-status` should show `MCP uses API key: yes`.
- **The first-launch key prompt** — the key itself lives in `~/.pi/agent/auth.json`
  (provider `exa`), the same place pi-exa's own `/exa-login` writes it. On a machine
  where it is missing, the first interactive pi start prompts once for the key
  (2-minute auto-dismiss) and stores it exactly like `/exa-login` does — 0600, other
  providers preserved. Because berszi's extension loads first and pi runs
  `session_start` handlers in order, the key is in place before pi-exa's first MCP
  connection: the very first search is already keyed. Dismiss the prompt and
  `/exa-login` remains as the manual path; print mode never prompts (it announces
  that `/exa-login` is needed instead); `EXA_API_KEY` counts as key present.

Workflow: keep the key in your password manager. New machine → install pi-berszi →
start pi → paste the key once → done, forever. The key is never sent anywhere but
Exa and never stored outside `auth.json` on that machine.

`/berszi exa off` clears the flag and stops the prompt; the new flag takes effect on
the next MCP (re)connect — pi-exa's own `/exa-mcp-use-api-key` toggle or a `/reload`
drops the cached client.

### chime

Two short stock macOS sounds at the moments a human is actually needed, so a pi
session you've backgrounded (or run over SSH) gets your attention without watching:

- **Glass** — `agent_settled`: the response is finished and pi is waiting for your input
- **Ping** — `ui_prompt_start`: pi is showing a blocking prompt (question / confirm / input)

Sounds are the system ones in `/System/Library/Sounds` (no assets shipped); playback is
`afplay`, detached and unref'd, so it never blocks a turn. On non-mac platforms the
listeners register but playback is a no-op — the feature reads "on" everywhere and simply
stays silent.

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
| `/berszi exa on` \| `off` | the Exa API-key flag |
| `/berszi chime on` \| `off` | the macOS system sounds |

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
