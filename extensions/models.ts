import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — models feature (bundled model config)
 *
 * Mirror of the author's local vLLM provider, shipped inside the extension:
 * every machine that has berszi installed gets the same models without the
 * extension writing to models.json.
 * pi.registerProvider() is the supported extension API: the call is queued
 * during initial load and applied once the runner binds its context, so the
 * models are available from the first session (no /reload). Re-registration
 * replaces the provider's models, so it stays idempotent. If a local
 * models.json also defines the provider under the same ID, the extension
 * layer composes on top of it (same model IDs → identical result). Edit
 * this file to change what the extension ships.
 */

export const VLLM_PROVIDER = "vllm";
const VLLM_BASE_URL = "http://100.116.35.7:8000/v1";
// The local vLLM server ignores the key; the literal dummy value marks the
// provider as auth-configured so pi's model picker lists the models.
const VLLM_API_KEY = "EMPTY";
// models.json expresses `compat` at provider level; the extension API takes
// it per model, so it is applied to each entry. supportsReasoningEffort is
// load-bearing: without it pi never puts reasoning_effort on the wire.
const VLLM_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: true };
// Thinking policy for the local Qwen models. The map values are what goes on
// the wire as reasoning_effort (openai-completions, supportsReasoningEffort):
// the session normally runs at high, which maps to xhigh. Every level stays
// supported (no nulls) — the compaction feature re-runs pi's compact() at
// "low" for these models, and a nulled level would clamp it back up to
// xhigh. With these Qwen-on-vLLM setups thinking is always on, so "low" is
// the floor (even "off" sends low).
const VLLM_THINKING = {
	off: "low",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "xhigh",
	xhigh: "xhigh",
	max: "xhigh",
};
const VLLM_MODELS: ProviderModelConfig[] = [
	{
		id: "heavy/Qwen3.8-27B-FP8",
		name: "Qwen3.8-27B dense (local, FP8)",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: VLLM_THINKING,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 216064,
		maxTokens: 24576,
		compat: VLLM_COMPAT,
	},
	{
		id: "heavy/Qwen3.8-27B-FP8-FULL",
		name: "Qwen3.8-27B dense (local, FP8-FULL)",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: VLLM_THINKING,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 24576,
		compat: VLLM_COMPAT,
	},
	{
		id: "heavy/Qwen3.8-27B-FP8-VISION",
		name: "Qwen3.8-27B dense (local, FP8-VISION)",
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: VLLM_THINKING,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 24576,
		compat: VLLM_COMPAT,
	},
];

let registered = false;

// --- Shipped default model ---------------------------------------------------
// The bundle makes the base FP8 model the default for new sessions — but only
// when the machine has no usable default of its own. pi resolves startup
// models from settings.json (defaultProvider + defaultModel); there is no
// extension API for defaults, so the feature maintains those two fields in
// <agent dir>/settings.json itself, touching nothing else:
//   - no default at all            -> set the shipped default
//   - a legacy name of this server -> rewrite the provider to vllm, keeping
//                                     the model choice if it is one of ours
//   - vllm + a model we no longer ship -> fix the model, keep the provider
//   - any other resolvable default -> respected, never overwritten
// Disabling the feature clears a dangling vllm default (the provider goes
// away with it). Project-level .pi/settings.json defaults still win over the
// global file, exactly like pi's own Ctrl+S default.

const DEFAULT_MODEL_ID = "heavy/Qwen3.8-27B-FP8";
// Provider names this local server carried on the author's machines before
// the bundle; settings.json files from that era still reference them.
const LEGACY_PROVIDER_NAMES = ["vllm-tailscale", "vllm-local"];

function settingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readSettingsFile(): { exists: boolean; settings: Record<string, unknown> | undefined } {
	try {
		const parsed = JSON.parse(readFileSync(settingsPath(), "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { exists: true, settings: undefined }; // corrupt: never rewrite
		}
		return { exists: true, settings: parsed as Record<string, unknown> };
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, settings: undefined };
		return { exists: true, settings: undefined }; // unreadable/corrupt: never rewrite
	}
}

/** Atomic patch of settings.json: merge over the read base, tmp file + rename. */
function writeSettings(base: Record<string, unknown> | undefined, patch: Record<string, unknown>): boolean {
	try {
		const next: Record<string, unknown> = { ...(base ?? {}), ...patch };
		const path = settingsPath();
		writeFileSync(`${path}.berszi-tmp`, JSON.stringify(next, null, 2) + "\n", "utf-8");
		renameSync(`${path}.berszi-tmp`, path); // atomic on the same filesystem
		return true;
	} catch {
		return false; // fail-open: the default simply stays as-is
	}
}

/** Returns the new default (provider/model) when a fix was written, else undefined. */
function ensureDefaultModel(): { newDefault: string; previous: string } | undefined {
	const { exists, settings } = readSettingsFile();
	if (!exists || settings === undefined) {
		if (!exists) {
			// Fresh machine: pi owns this file, but creating it with just the
			// two default fields is safe — pi merges field-by-field on save.
			if (writeSettings(undefined, { defaultProvider: VLLM_PROVIDER, defaultModel: DEFAULT_MODEL_ID })) {
				return { newDefault: `${VLLM_PROVIDER}/${DEFAULT_MODEL_ID}`, previous: "(none)" };
			}
		}
		return; // corrupt/unreadable: never rewrite by hand
	}
	const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined;
	const model = typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
	const previous = provider || model ? `${provider ?? "?"}/${model ?? "?"}` : "(none)";
	const shippedIds = VLLM_MODELS.map((m) => m.id);

	if (provider === VLLM_PROVIDER && model === DEFAULT_MODEL_ID) return; // already the shipped default

	// Legacy name of this same server: keep the model choice if it is one of ours.
	if (provider && LEGACY_PROVIDER_NAMES.includes(provider)) {
		const modelId = model && shippedIds.includes(model) ? model : DEFAULT_MODEL_ID;
		if (writeSettings(settings, { defaultProvider: VLLM_PROVIDER, defaultModel: modelId })) {
			return { newDefault: `${VLLM_PROVIDER}/${modelId}`, previous };
		}
		return;
	}

	// No default at all: ship the bundle default.
	if (!provider || !model) {
		if (writeSettings(settings, { defaultProvider: VLLM_PROVIDER, defaultModel: DEFAULT_MODEL_ID })) {
			return { newDefault: `${VLLM_PROVIDER}/${DEFAULT_MODEL_ID}`, previous };
		}
		return;
	}

	// Our provider, but a model id we no longer ship (renamed/removed).
	if (provider === VLLM_PROVIDER && !shippedIds.includes(model)) {
		if (writeSettings(settings, { defaultModel: DEFAULT_MODEL_ID })) {
			return { newDefault: `${VLLM_PROVIDER}/${DEFAULT_MODEL_ID}`, previous };
		}
		return;
	}

	// A default for another provider, or one of our other shipped models:
	// the user's choice — respect it.
}

/** Clear a dangling vllm default (only our provider's; never the user's others). */
function clearBundledDefault(): void {
	const { settings } = readSettingsFile();
	if (!settings) return;
	if (typeof settings.defaultProvider === "string" && settings.defaultProvider === VLLM_PROVIDER) {
		writeSettings(settings, { defaultProvider: undefined, defaultModel: undefined }); // keys dropped
	}
}

let defaultNotice: string | undefined;

export const modelsFeature = {
	name: "models",
	description: "bundled vLLM provider + default model (Qwen3.8-27B-FP8)",
	enable(pi: ExtensionAPI): boolean {
		let ok = false;
		try {
			pi.registerProvider(VLLM_PROVIDER, {
				baseUrl: VLLM_BASE_URL,
				apiKey: VLLM_API_KEY,
				api: "openai-completions",
				models: VLLM_MODELS,
			});
			ok = true;
		} catch {
			// fail-open: provider simply absent
		}
		registered = ok;
		// Default-model maintenance runs even if registration failed: the
		// settings fix is independent, and a broken provider registration
		// must not mask a stale default. (It will re-run on the next enable.)
		const fix = ensureDefaultModel();
		if (fix) {
			defaultNotice = `berszi: default model set to ${fix.newDefault} (was ${fix.previous})`;
			pi.on("session_start", (_event, ctx) => {
				if (!defaultNotice) return;
				const note = defaultNotice;
				defaultNotice = undefined; // one-shot
				try {
					ctx.ui?.notify?.(note);
				} catch {
					/* non-interactive mode */
				}
			});
		}
		return ok;
	},
	disable(pi: ExtensionAPI): boolean {
		if (registered) {
			try {
				pi.unregisterProvider(VLLM_PROVIDER);
			} catch {
				/* already gone */
			}
			registered = false;
		}
		try {
			clearBundledDefault(); // the provider goes away; don't leave a dangling default
		} catch {
			/* best effort */
		}
		return true;
	},
	attached(): boolean {
		return registered;
	},
};
