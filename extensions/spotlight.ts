import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent, VERSION } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — thinking + tool fold
 *
 * Thinking: while a thinking run streams, pi renders it normally (full text,
 * live). The moment a run settles — a text/tool block follows it in the
 * message, or the message finishes — spotlight folds it to a 3-line glimpse
 * of the reasoning (no label). The first glimpse line replaces the stock
 * label line, keeping its styling and the click target — click it to
 * re-expand the full run; runs you expand are never re-folded.
 *
 * Tools: pi's default is rows collapsed. Spotlight inverts that for the
 * duration of a run: the moment a tool starts, its row expands and streams
 * live output; the moment the result lands, the row collapses to a single
 * header line. Click the row or press Ctrl+O to re-expand; rows you touch
 * are never re-folded. If you globally expand with Ctrl+O, spotlight backs
 * off and lets stock behavior run. Failed rows stay open so you can see
 * what went wrong; resumed history renders exactly like stock pi.
 *
 * Display-only: the session file, model context, and compaction are never
 * touched. The implementation is a guarded wrapper around
 * AssistantMessageComponent.prototype.updateContent plus four guarded
 * wrappers around ToolExecutionComponent prototype methods (setExpanded,
 * markExecutionStarted, updateResult, updateDisplay). If pi's internals ever
 * change shape, the wrappers detect the mismatch and fall back to stock
 * rendering (fail-open). No re-render churn: state is seeded before the
 * native render runs.
 *
 * Commands:
 *   /spotlight        — status
 *   /spotlight on     — enable (default)
 *   /spotlight off    — restore stock behavior
 *
 * Tested against pi 1.1.0.
 */

const DEFAULT_LABEL = "Thinking...";
const SETTLED_LABEL = "Thought";
const TESTED_VERSION = "1.1";
const PATCHED = Symbol.for("spotlight.updateContent.patches");
const ORIGINAL = Symbol.for("spotlight.updateContent.original");
const RENDER_PATCHED = Symbol.for("spotlight.render.patches");
const RENDER_ORIGINAL = Symbol.for("spotlight.render.original");
const TOOLS_PATCHED = Symbol.for("spotlight.updateResult.patched");
const TOOLS_ORIGINAL = Symbol.for("spotlight.updateResult.original");
const DISABLED = Symbol.for("spotlight.disabled");
const USER_OPENED: WeakMap<object, Set<number>> = new WeakMap();

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
}

interface RunInfo {
	index: number;
	settled: boolean;
	text: string;
}

/**
 * Mirror of the run grouping inside AssistantMessageComponent.updateContent:
 * consecutive `thinking` blocks form one run; groups with no non-empty
 * thinking are skipped and — critically — do not consume a run index.
 * The numbering must match the native loop exactly, or we would seed the
 * wrong runs.
 *
 * A run is settled when a non-thinking block (text/toolCall) now follows it
 * in the content, or when the message is no longer streaming.
 */
function thinkingRuns(content: unknown, isStreaming: boolean): RunInfo[] {
	if (!Array.isArray(content)) return [];
	const runs: RunInfo[] = [];
	let runIndex = 0;
	let i = 0;
	while (i < content.length) {
		const block = content[i] as ContentBlock | undefined;
		if (!block || block.type !== "thinking") {
			i++;
			continue;
		}
		let hasText = false;
		const blocks: string[] = [];
		while (i < content.length) {
			const b = content[i] as ContentBlock;
			if (!b || b.type !== "thinking") break;
			if (typeof b.thinking === "string" && b.thinking.trim()) {
				hasText = true;
				blocks.push(b.thinking.trim());
			}
			i++;
		}
		if (!hasText) continue; // native skips empty groups without numbering them
		const followedByBlock = i < content.length;
		runs.push({ index: runIndex++, settled: followedByBlock || !isStreaming, text: blocks.join("\n\n") });
	}
	return runs;
}

const stripAnsi = (line: string): string =>
	line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/**
 * Glimpse lines for a folded run: the first 3 non-empty thinking lines,
 * truncated to the terminal width. Reuses the collapsed label line's own
 * ANSI styling (theme + NO_COLOR safe: plain text when the label has none).
 */
function buildPreview(text: string, width: number, labelLine: string, labelText: string): string[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
	if (!lines.length) return [];
	// trim trailing padding spaces so they are not baked into every preview line
	const styled = labelLine.replace(/\s+$/, "");
	const idx = styled.indexOf(labelText);
	const pre = idx >= 0 ? styled.slice(0, idx) : "";
	const post = idx >= 0 ? styled.slice(idx + labelText.length) : "";
	const ws = pre.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
	const openers = pre.replace(/^\s+/, "");
	const budget = Math.max(10, width - ws.length);
	return lines.map((l) => ws + openers + (l.length > budget ? l.slice(0, budget - 1) + "…" : l) + post);
}

export default function spotlight(pi: ExtensionAPI): void {
	const proto = (AssistantMessageComponent as unknown as {
		prototype?: { updateContent?: unknown; render?: unknown };
	})?.prototype;
	const g = globalThis as Record<symbol, unknown>;

	const userOpened = (component: object): Set<number> => {
		let set = USER_OPENED.get(component);
		if (!set) {
			set = new Set();
			USER_OPENED.set(component, set);
		}
		return set;
	};

	// `original` lives on globalThis, not in a closure: pi re-runs this factory
	// (e.g. /reload), and a later closure must still be able to restore the
	// stock method installed by an earlier one.
	const patch = (): boolean => {
		if (!proto || typeof proto.updateContent !== "function") return false;
		if ((proto.updateContent as { [PATCHED]?: boolean })[PATCHED]) {
			wrapRender(); // render wrap may be missing from an earlier partial run
			return true; // already active
		}
		const original = proto.updateContent as (message: unknown, isStreaming?: boolean) => void;
		const wrapped = function (this: Record<string, unknown>, message: unknown, isStreaming?: boolean) {
			try {
				const overrides = this.thinkingVisibilityOverrides as unknown;
				// Only take over visibility while the native hide-setting is off;
				// with Ctrl+T on, the user wants the stock global behavior.
				if (message && this.hideThinkingBlock === false && overrides instanceof Map) {
					const runs = thinkingRuns(
						(message as { content?: unknown }).content,
						isStreaming ?? (this.isStreaming === true),
					);
					const opened = userOpened(this);
					let anySettled = false;
					for (const run of runs) {
						// A seeded run reading `false` here was toggled by a click.
						if (overrides.get(run.index) === false) opened.add(run.index);
						if (!run.settled) continue;
						anySettled = true;
						if (!opened.has(run.index) && overrides.get(run.index) !== true) {
							overrides.set(run.index, true);
						}
					}
					// Finished runs read "Thought"; leave user-custom labels alone.
					const label = this.hiddenThinkingLabel as string | undefined;
					if (anySettled && (label === DEFAULT_LABEL || label === SETTLED_LABEL)) {
						this.hiddenThinkingLabel = SETTLED_LABEL;
					}
				}
			} catch {
				// fail-open: stock rendering
			}
			return original.call(this, message, isStreaming);
		};
		try {
			(wrapped as { [PATCHED]?: boolean })[PATCHED] = true;
			proto.updateContent = wrapped as unknown as typeof proto.updateContent;
			g[ORIGINAL] = original;
			wrapRender();
			return true;
		} catch {
			return false;
		}
	};

	// Collapsed runs render as a 3-line glimpse of the thinking itself. The
	// wrapper runs after the native render (which returns a fresh array),
	// finds each collapsed label line, replaces it with the first glimpse
	// line (same styling, keeps the click target for re-expand), and splices
	// the remaining glimpse lines after it. The k-th label line maps to the
	// k-th collapsed run, in content order.
	const wrapRender = (): void => {
		try {
			if (!proto || typeof proto.render !== "function") return;
			if ((proto.render as { [RENDER_PATCHED]?: boolean })[RENDER_PATCHED]) return; // already active
			const original = proto.render as (this: Record<string, unknown>, width: number) => string[];
			const wrapped = function (this: Record<string, unknown>, width: number) {
				const lines = original.call(this, width);
				try {
					if (this.hideThinkingBlock === false && lines.length > 0) {
						const overrides = this.thinkingVisibilityOverrides as unknown;
						const message = this.lastMessage as { content?: unknown } | undefined;
						const label = typeof this.hiddenThinkingLabel === "string" ? this.hiddenThinkingLabel : DEFAULT_LABEL;
							if (overrides instanceof Map && message && label.trim()) {
								const runs = thinkingRuns(message.content, this.isStreaming === true).filter(
								(r) => r.text.trim() && overrides.get(r.index) === true,
								);
								if (runs.length) {
									const out = [...lines];
									let k = 0;
									for (let i = 0; i < out.length && k < runs.length; i++) {
										if (stripAnsi(out[i]).trim() !== label.trim()) continue;
										const preview = buildPreview(runs[k].text, width, out[i], label);
										out[i] = preview[0]; // first glimpse line takes the label's place
										out.splice(i + 1, 0, ...preview.slice(1));
										i += preview.length - 1;
										k++;
									}
									return out;
								}
								}
							}
						} catch {
						// fail-open: stock lines
						}
						return lines;
					};
				(wrapped as { [RENDER_PATCHED]?: boolean })[RENDER_PATCHED] = true;
				proto.render = wrapped as unknown as typeof proto.render;
				g[RENDER_ORIGINAL] = original;
			} catch {
				// fail-open: label-only fold keeps working
			}
		};

	const unpatch = (): boolean => {
		const original = g[ORIGINAL] as ((message: unknown, isStreaming?: boolean) => void) | undefined;
		const originalRender = g[RENDER_ORIGINAL] as ((this: Record<string, unknown>, width: number) => string[]) | undefined;
		let restored = false;
		if (proto && typeof original === "function" && (proto.updateContent as { [PATCHED]?: boolean })?.[PATCHED]) {
			proto.updateContent = original as typeof proto.updateContent;
			delete g[ORIGINAL];
			restored = true;
		}
		if (proto && typeof originalRender === "function" && (proto.render as { [RENDER_PATCHED]?: boolean })?.[RENDER_PATCHED]) {
			proto.render = originalRender as typeof proto.render;
			delete g[RENDER_ORIGINAL];
			restored = true;
		}
		return restored;
	};

	// ── Tools ──────────────────────────────────────────────────────────────
	// pi 1.1.0 defaults to toolOutputExpanded = false: rows are created
	// collapsed and stay that way. Spotlight inverts that only for the rows
	// it owns:
	//   markExecutionStarted → the row goes live: expand it (full live output)
	//   final updateResult   → the row is done: collapse it
	// Settled, collapsed, non-error rows render as a single header line:
	// the updateDisplay wrapper strips the result region out of the content
	// box, so even tools whose native compact form shows a preview (bash
	// keeps a 5-line tail) collapse to just the call line. Click the header
	// or press Ctrl+O to re-expand; the strip is re-evaluated on every
	// updateDisplay, so the result comes back exactly when the row expands.
	// Ownership rules:
	//   - spotlight only owns a row if it was still collapsed at start. If the
	//     user has globally expanded (Ctrl+O), rows arrive already expanded
	//     and spotlight stays out of the way entirely.
	//   - any user action (click / Ctrl+O) after the row started is recorded;
	//     the row is never touched again.
	//   - failed rows are left open; history rows (never executed) are never
	//     owned, so resumed sessions render exactly like stock pi.
	// pi's own init calls (setExpanded(global) right after construction) are
	// ignored via a creation window that stays open until the first
	// markExecutionStarted or final updateResult.
	const toolProto = (ToolExecutionComponent as unknown as {
		prototype?: {
			setExpanded?: unknown;
			markExecutionStarted?: unknown;
			updateResult?: unknown;
			updateDisplay?: unknown;
		};
	})?.prototype;

	interface ToolRow {
		expanded?: boolean;
		isPartial?: boolean;
		result?: { isError?: boolean };
		hideComponent?: boolean;
		toolDefinition?: { renderShell?: string };
		contentBox?: { children: unknown[]; removeChild(component: unknown): void };
		selfRenderContainer?: { children: unknown[]; removeChild(component: unknown): void };
		imageComponents?: unknown[];
		imageSpacers?: unknown[];
		setExpanded(expanded: boolean): void;
		removeChild(component: unknown): void;
	}
	interface ToolRowState {
		windowOpen: boolean; // creation-window: init calls don't count as user
		touched: boolean; // user (or Ctrl+O) acted after the window closed
		owned: boolean; // spotlight expanded this row itself
	}
	const toolRowState = new WeakMap<ToolRow, ToolRowState>();
	let toolDepth = 0; // >0 while spotlight itself is calling setExpanded

	const ensureToolState = (row: ToolRow): ToolRowState => {
		let st = toolRowState.get(row);
		if (!st) {
			st = { windowOpen: true, touched: false, owned: false };
			toolRowState.set(row, st);
		}
		return st;
	};

	const origToolSet = toolProto?.setExpanded as (this: ToolRow, expanded: boolean) => void;
	const origToolMark = toolProto?.markExecutionStarted as (this: ToolRow) => void;
	const origToolUpdate = toolProto?.updateResult as (this: ToolRow, result: unknown, isPartial?: boolean) => void;
	const origToolDisplay = toolProto?.updateDisplay as (this: ToolRow) => void;

	const wrappedToolSet = function (this: ToolRow, expanded: boolean) {
		try {
			const st = ensureToolState(this);
			if (toolDepth === 0 && !st.windowOpen) st.touched = true;
		} catch {
			// fail-open
		}
		return origToolSet.call(this, expanded);
	};

	const wrappedToolMark = function (this: ToolRow) {
		const ret = origToolMark.call(this);
		try {
			const st = ensureToolState(this);
			st.windowOpen = false;
			if (!st.touched && this.expanded !== true) {
				st.owned = true;
				toolDepth++;
				try {
					this.setExpanded(true);
				} finally {
					toolDepth--;
				}
			}
		} catch {
			// fail-open
		}
		return ret;
	};

	const wrappedToolUpdate = function (this: ToolRow, result: unknown, isPartial?: boolean) {
		const ret = origToolUpdate.call(this, result, isPartial);
		try {
			if (isPartial !== true) {
				const st = ensureToolState(this);
				st.windowOpen = false;
				if (st.owned && !st.touched && this.expanded === true && !this.result?.isError) {
					toolDepth++;
					try {
						this.setExpanded(false);
					} finally {
						toolDepth--;
					}
				}
			}
		} catch {
			// fail-open
		}
		return ret;
	};

	// Single-line settled rows: strip the result region (and any result
	// images) so only the call header line remains. Runs after every native
	// updateDisplay, so the result reappears the moment the row is expanded
	// again (user click / Ctrl+O) or a new partial update streams in.
	const wrappedToolDisplay = function (this: ToolRow) {
		origToolDisplay.call(this);
		try {
			// default-shell tools render into contentBox; self-shell tools (edit)
			// render into selfRenderContainer — same shape (call region first,
			// result region after), so the same strip works for both.
			const box = this.toolDefinition?.renderShell === "self" ? this.selfRenderContainer : this.contentBox;
			if (
				this.toolDefinition &&
				box &&
				!this.hideComponent &&
				this.expanded !== true &&
				this.isPartial !== true &&
				this.result &&
				!this.result.isError
			) {
				while (box.children.length > 1) {
					box.removeChild(box.children[box.children.length - 1]);
				}
				// the edit tool's self-shell renders the diff INSIDE the call Box
			// (header Text + Spacer + diff Text) — strip it to the header line.
				// Other tools' call regions are single Texts (children undefined): no-op.
				const callBox = (box.children[0] as { child?: { children?: unknown[]; removeChild(component: unknown): void } } | undefined)?.child;
				if (callBox && Array.isArray(callBox.children)) {
					while (callBox.children.length > 1) {
						callBox.removeChild(callBox.children[callBox.children.length - 1]);
					}
				}
				for (const img of this.imageComponents ?? []) this.removeChild(img);
				for (const sp of this.imageSpacers ?? []) this.removeChild(sp);
				this.imageComponents = [];
				this.imageSpacers = [];
			}
		} catch {
			// fail-open: stock rendering
		}
	};

	const patchTools = (): boolean => {
		if (
			!toolProto ||
			typeof origToolSet !== "function" ||
			typeof origToolMark !== "function" ||
			typeof origToolUpdate !== "function" ||
			typeof origToolDisplay !== "function"
		) {
			return false;
		}
		if ((toolProto as { [TOOLS_PATCHED]?: boolean })[TOOLS_PATCHED]) return true; // already active
		try {
			g[TOOLS_ORIGINAL] = {
				setExpanded: toolProto.setExpanded,
				markExecutionStarted: toolProto.markExecutionStarted,
				updateResult: toolProto.updateResult,
				updateDisplay: toolProto.updateDisplay,
			};
			(toolProto as { [TOOLS_PATCHED]?: boolean })[TOOLS_PATCHED] = true;
			toolProto.setExpanded = wrappedToolSet as unknown as typeof toolProto.setExpanded;
			toolProto.markExecutionStarted = wrappedToolMark as unknown as typeof toolProto.markExecutionStarted;
			toolProto.updateResult = wrappedToolUpdate as unknown as typeof toolProto.updateResult;
			toolProto.updateDisplay = wrappedToolDisplay as unknown as typeof toolProto.updateDisplay;
			return true;
		} catch {
			delete g[TOOLS_ORIGINAL];
			delete (toolProto as { [TOOLS_PATCHED]?: boolean })[TOOLS_PATCHED];
			return false;
		}
	};

	const unpatchTools = (): boolean => {
		const saved = g[TOOLS_ORIGINAL] as {
			setExpanded?: unknown;
			markExecutionStarted?: unknown;
			updateResult?: unknown;
			updateDisplay?: unknown;
		} | undefined;
		if (toolProto && saved?.setExpanded && (toolProto as { [TOOLS_PATCHED]?: boolean })?.[TOOLS_PATCHED]) {
			toolProto.setExpanded = saved.setExpanded as typeof toolProto.setExpanded;
			toolProto.markExecutionStarted = saved.markExecutionStarted as typeof toolProto.markExecutionStarted;
			toolProto.updateResult = saved.updateResult as typeof toolProto.updateResult;
			toolProto.updateDisplay = saved.updateDisplay as typeof toolProto.updateDisplay;
			delete (toolProto as { [TOOLS_PATCHED]?: boolean })[TOOLS_PATCHED];
			delete g[TOOLS_ORIGINAL];
			return true;
		}
		return false;
	};

	let thinkingOk: boolean;
	let toolsOk: boolean;
	if (DISABLED in g) {
		// Off must keep holding across a factory re-run: drop wraps that an
		// earlier run of this extension left on the prototypes.
		unpatch();
		unpatchTools();
		thinkingOk = false;
		toolsOk = false;
	} else {
		thinkingOk = patch();
		toolsOk = patchTools();
	}
	let enabled = thinkingOk || toolsOk;

	pi.on("session_start", (_event, ctx) => {
		const notify = (message: string, type: "info" | "warning") => {
			try {
				ctx.ui?.notify?.(message, type);
			} catch {
				/* non-interactive mode */
			}
		};
		if (!enabled) {
			// Degradation must be announced, not silent (fail-open contract).
			if (!(DISABLED in g)) notify("spotlight: disabled — could not attach (pi internals changed?)", "warning");
			return;
		}
		const piVersion = String(VERSION ?? "").split(".").slice(0, 2).join(".");
		const versionNote = piVersion === TESTED_VERSION ? "" : ` (untested on pi ${piVersion})`;
		if (thinkingOk && toolsOk) {
			notify(`spotlight: thinking + tool fold on${versionNote}`, piVersion === TESTED_VERSION ? "info" : "warning");
		} else if (thinkingOk) {
			notify("spotlight: thinking fold on — tool fold could not attach (pi internals changed?)", "warning");
		} else {
			notify("spotlight: tool fold on — thinking fold could not attach (pi internals changed?)", "warning");
		}
	});

	pi.registerCommand("spotlight", {
		description: "spotlight: on | off (no args: status)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui?.notify?.(message, type);
				} catch {
					/* non-interactive mode */
				}
			};
			try {
				if (arg === "off") {
					const restoredThinking = unpatch();
					const restoredTools = unpatchTools();
					enabled = false;
					thinkingOk = false;
					toolsOk = false;
					g[DISABLED] = true;
					notify(
						restoredThinking || restoredTools
							? "spotlight: off — stock thinking + tool display"
							: "spotlight: off (nothing to restore)",
					);
				} else if (arg === "on") {
					delete g[DISABLED];
					thinkingOk = patch();
					toolsOk = patchTools();
					enabled = thinkingOk || toolsOk;
					if (enabled && thinkingOk && toolsOk) {
						notify("spotlight: on");
					} else if (enabled) {
						notify(
							thinkingOk
								? "spotlight: on — tool fold could not attach (pi internals changed?)"
								: "spotlight: on — thinking fold could not attach (pi internals changed?)",
							"warning",
						);
					} else {
						notify("spotlight: could not attach — pi internals changed?", "warning");
					}
				} else {
					const parts: string[] = [];
					if (thinkingOk) parts.push("thinking");
					if (toolsOk) parts.push("tools");
					notify(
						enabled
							? `spotlight: on — ${parts.join(" + ")} fold (pi ${String(VERSION ?? "?")})`
							: `spotlight: off (pi ${String(VERSION ?? "?")})`,
					);
				}
			} catch (err) {
				notify(`spotlight: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
