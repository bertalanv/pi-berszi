import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VLLM_PROVIDER } from "./models.js";

/**
 * berszi — compaction feature (low-effort summarization for local models)
 *
 * pi compacts long sessions with a summarization LLM call that always runs
 * at the session's current thinking level, and pi has no setting to change
 * that. For the local vLLM models that means a mechanical summarization
 * runs at full effort on slow local inference.
 *
 * When the active model belongs to the bundled vllm provider, this feature
 * re-runs pi's own compact() for that model with the thinking level pinned
 * to "low" — same model, same cut point, same prompt, same persistence;
 * only the effort of the summarization call differs. Every other model
 * (cloud Qwen, DeepSeek, Claude via pi-claude-bridge, ...) is left alone:
 * the hook returns undefined and pi compacts as usual.
 *
 * The match is on the provider, not a model-ID list, so the feature cannot
 * silently drift out of sync with the models feature: every model the
 * bundle registers under the vllm provider is covered, plus any vllm model
 * a local models.json adds under the same provider.
 *
 * "low" only reaches vLLM because models.ts keeps it a supported thinking
 * level (a nulled thinkingLevelMap entry would clamp it upward) and maps it
 * to the wire value the server accepts.
 *
 * On failure: one short warning, then pi's built-in compaction. Never
 * cancels, never crashes the session; an aborted (Esc) compaction is silent.
 */

const LOW_EFFORT_THINKING_LEVEL = "low";

type FileOps = { read: Set<string>; edited: Set<string> };

/**
 * pi does not carry file lists over from hook-provided compactions (its own
 * carry-over only merges details from entries it generated itself), so merge
 * the previous compaction's lists back into the preparation pi handed over.
 * Without this, the lists would silently vanish after two rounds of hook
 * compaction. Defensive shape checks guard against foreign details.
 */
function restorePreviousFileOps(fileOps: FileOps, branchEntries: { type: string; details?: unknown }[]): void {
	const previous = [...branchEntries].reverse().find((entry) => entry.type === "compaction");
	const details = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!details) return;
	for (const f of Array.isArray(details.readFiles) ? details.readFiles : []) if (typeof f === "string") fileOps.read.add(f);
	for (const f of Array.isArray(details.modifiedFiles) ? details.modifiedFiles : []) if (typeof f === "string") fileOps.edited.add(f);
}

let detach: (() => void) | undefined;

export const compactionFeature = {
	name: "compaction",
	description: "compact local vLLM sessions at low thinking effort (same model, pi's own compact())",
	enable(pi: ExtensionAPI): boolean {
		if (detach) return true; // idempotent across toggles in one process
		try {
			detach = pi.on("session_before_compact", async (event, ctx) => {
				const model = ctx.model;
				if (!model || model.provider !== VLLM_PROVIDER) return; // built-in compaction
				// Already aborted (Esc landed before the hook ran): compact() would not
				// throw on a pre-aborted signal — it would return an empty summary, and
				// returning that would persist a useless compaction entry. Do nothing.
				if (event.signal.aborted) return;

				try {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) throw new Error(auth.error);
					restorePreviousFileOps(event.preparation.fileOps, event.branchEntries);
					const compaction = await compact(
						event.preparation,
						model,
						auth.apiKey,
						auth.headers,
						event.customInstructions,
						event.signal,
						LOW_EFFORT_THINKING_LEVEL,
						undefined,
						auth.env,
					);
					return { compaction };
				} catch (error) {
					if (event.signal.aborted) return; // Esc: silent, like pi's own aborts
					const message = error instanceof Error ? error.message : String(error);
					try {
						ctx.ui?.notify?.(`local-compaction: ${message} — using pi's built-in compaction`, "warning");
					} catch {
						/* non-interactive mode: the fallback still happens */
					}
					return;
				}
			});
			return true;
		} catch {
			// fail-open: pi's built-in compaction is unaffected
			detach = undefined;
			return false;
		}
	},
	disable(_pi: ExtensionAPI): boolean {
		try {
			detach?.();
		} catch {
			/* already gone */
		}
		detach = undefined;
		return true;
	},
	attached(): boolean {
		return detach !== undefined;
	},
};
