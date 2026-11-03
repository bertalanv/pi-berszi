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
		// Window matches the engine's max_model_len exactly. The compaction
		// trigger reserve is delivered by this file (VLLM_COMPACTION_RESERVES
		// -> settings.json compaction.modelOverrides): 38,077 -> compact at
		// 224,067. maxTokens equals that reserve on purpose: it is the other
		// side of the summary cap (see compaction.ts).
		contextWindow: 262144,
		maxTokens: 38077,
		compat: VLLM_COMPAT,
	},
	// Served by the `start_yarn` vLLM server (730k context, text-only).
	// maxTokens is doubled vs. the base models for extra response headroom in
	// long sessions; the compaction summary budget is independent (the
	// compaction feature pins it at 24,576 regardless of maxTokens).
	{
		id: "heavy/Qwen3.8-27B-FP8-YARN",
		name: "Qwen3.8-27B dense (local, FP8-YARN)",
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: VLLM_THINKING,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 730000,
		maxTokens: 49152,
		compat: VLLM_COMPAT,
	},
	// Served by the `vision_yarn` vLLM server (500k context, text + image).
	// Same doubled output limit as FP8-YARN (see above).
	{
		id: "heavy/Qwen3.8-27B-VISION-YARN",
		name: "Qwen3.8-27B dense (local, VISION-YARN)",
		input: ["text", "image"],
		reasoning: true,
		thinkingLevelMap: VLLM_THINKING,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 49152,
		compat: VLLM_COMPAT,
	},
];

let registered = false;

// --- Per-model compaction reserves ------------------------------------------
// pi triggers auto-compaction at contextWindow - reserveTokens, with the
// per-model value taken from compaction.modelOverrides["provider/modelId"]
// in <agent dir>/settings.json. There is no extension API for it, and the
// built-in default (16,384) makes the 262K models compact ~8 points late
// (93.75% instead of 85.5%), so the bundle ships these entries too and
// maintains them like the default model: missing entries are written, a
// legacy name of this server is moved to the vllm key keeping its value, and
// any other explicit value is the user's local tuning — respected, never
// overwritten. Disabling the feature drops the entries it wrote (bundled
// value under the vllm key) and never touches tuned values. A reserve must
// stay >= the model's compaction summary output budget (SUMMARY_OUTPUT_CAP,
// compaction.ts) — VISION's maxTokens and reserve are 38,077 on purpose.
const VLLM_COMPACTION_RESERVES: Record<string, number> = {
	"heavy/Qwen3.8-27B-FP8": 24576,
	"heavy/Qwen3.8-27B-FP8-FULL": 24576,
	"heavy/Qwen3.8-27B-FP8-VISION": 38077,
	"heavy/Qwen3.8-27B-FP8-YARN": 24576,
	"heavy/Qwen3.8-27B-VISION-YARN": 24576,
};

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

// --- Per-model compaction reserve maintenance --------------------------------

/** The reserveTokens of one modelOverrides entry, or undefined. */
function overrideReserve(overrides: Record<string, unknown>, key: string): number | undefined {
	const entry = overrides[key];
	const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>).reserveTokens : undefined;
	return typeof value === "number" ? value : undefined;
}

/**
 * Ensure the shipped per-model compaction reserves are in settings.json.
 * Returns a notice of what changed, or undefined when nothing did.
 */
function ensureCompactionReserves(): string | undefined {
	const { exists, settings } = readSettingsFile();
	if (!exists) {
		// Fresh machine: pi owns this file; creating it with just the
		// compaction block is safe — pi merges field-by-field on save.
		const overrides: Record<string, { reserveTokens: number }> = {};
		for (const [modelId, reserve] of Object.entries(VLLM_COMPACTION_RESERVES)) {
			overrides[`${VLLM_PROVIDER}/${modelId}`] = { reserveTokens: reserve };
		}
		if (writeSettings(undefined, { compaction: { modelOverrides: overrides } })) {
			return "compaction reserves set for the bundled models";
		}
		return;
	}
	if (settings === undefined) return; // corrupt: never rewrite by hand
	const compactionRaw = settings.compaction;
	if (compactionRaw !== undefined && (typeof compactionRaw !== "object" || compactionRaw === null || Array.isArray(compactionRaw))) {
		return; // broken compaction block: leave it to pi/user
	}
	const compaction = (compactionRaw ?? {}) as Record<string, unknown>;
	const overrides = { ...((compaction.modelOverrides ?? {}) as Record<string, unknown>) };
	const changed: string[] = [];
	for (const [modelId, shipped] of Object.entries(VLLM_COMPACTION_RESERVES)) {
		const key = `${VLLM_PROVIDER}/${modelId}`;
		const current = overrideReserve(overrides, key);
		if (current !== undefined) continue; // correct or locally tuned: hands off
		let source = overrides[key]; // entry with other fields, e.g. keepRecentTokens
		let value = shipped;
		for (const legacy of LEGACY_PROVIDER_NAMES) {
			const legacyKey = `${legacy}/${modelId}`;
			const legacyValue = overrideReserve(overrides, legacyKey);
			if (legacyValue === undefined) continue;
			value = legacyValue; // same server's old name: keep the chosen value
			source = overrides[legacyKey];
			delete overrides[legacyKey];
			break;
		}
		const entry = { ...(source && typeof source === "object" ? (source as Record<string, unknown>) : {}) };
		entry.reserveTokens = value;
		overrides[key] = entry;
		changed.push(value === shipped ? key : `${key}=${value}`);
	}
	if (!changed.length) return;
	if (!writeSettings(settings, { compaction: { ...compaction, modelOverrides: overrides } })) return;
	return `compaction reserves set: ${changed.join(", ")}`;
}

/** Drop the reserve entries the bundle wrote; never touch locally tuned values. */
function clearBundledCompactionReserves(): void {
	const { settings } = readSettingsFile();
	if (!settings) return;
	const compactionRaw = settings.compaction;
	if (compactionRaw === undefined || compactionRaw === null || typeof compactionRaw !== "object" || Array.isArray(compactionRaw)) return;
	const compaction = compactionRaw as Record<string, unknown>;
	const overridesRaw = compaction.modelOverrides;
	if (overridesRaw === undefined || overridesRaw === null || typeof overridesRaw !== "object" || Array.isArray(overridesRaw)) return;
	const overrides = { ...(overridesRaw as Record<string, unknown>) };
	let changed = false;
	for (const [modelId, shipped] of Object.entries(VLLM_COMPACTION_RESERVES)) {
		const key = `${VLLM_PROVIDER}/${modelId}`;
		if (overrideReserve(overrides, key) === shipped) {
			delete overrides[key]; // bundled value under our provider: we own it
			changed = true;
		}
	}
	if (!changed) return;
	const empty = Object.keys(overrides).length === 0;
	writeSettings(settings, { compaction: { ...compaction, modelOverrides: empty ? undefined : overrides } }); // keys dropped
}

let defaultNotice: string | undefined;

export const modelsFeature = {
	name: "models",
	description: "bundled vLLM provider, default model, per-model compaction reserves",
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
		// Settings.json maintenance runs even if registration failed: the
		// settings fixes are independent, and a broken provider registration
		// must not mask a stale default or missing reserves. (It will re-run
		// on the next enable.)
		const notices: string[] = [];
		const fix = ensureDefaultModel();
		if (fix) notices.push(`default model set to ${fix.newDefault} (was ${fix.previous})`);
		const reserves = ensureCompactionReserves();
		if (reserves) notices.push(reserves);
		if (notices.length) {
			defaultNotice = `berszi: ${notices.join("; ")}`;
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
			clearBundledCompactionReserves(); // ...or dangling reserve entries
		} catch {
			/* best effort */
		}
		return true;
	},
	attached(): boolean {
		return registered;
	},
};
