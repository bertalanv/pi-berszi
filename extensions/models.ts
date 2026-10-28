import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

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

const VLLM_PROVIDER = "vllm";
const VLLM_BASE_URL = "http://100.116.35.7:8000/v1";
// The local vLLM server ignores the key; the literal dummy value marks the
// provider as auth-configured so pi's model picker lists the models.
const VLLM_API_KEY = "EMPTY";
// models.json expresses `compat` at provider level; the extension API takes
// it per model, so it is applied to each entry.
const VLLM_COMPAT = { supportsDeveloperRole: false };
const VLLM_MODELS: ProviderModelConfig[] = [
	{
		id: "heavy/Qwen3.8-27B-FP8",
		name: "Qwen3.8-27B dense (local, FP8)",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 216064,
		maxTokens: 65536,
		compat: VLLM_COMPAT,
	},
	{
		id: "heavy/Qwen3.8-27B-FP8-FULL",
		name: "Qwen3.8-27B dense (local, FP8-FULL)",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 24576,
		compat: VLLM_COMPAT,
	},
	{
		id: "heavy/Qwen3.8-27B-FP8-VISION",
		name: "Qwen3.8-27B dense (local, FP8-VISION)",
		input: ["text", "image"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 24576,
		compat: VLLM_COMPAT,
	},
];

let registered = false;

export const modelsFeature = {
	name: "models",
	description: "bundled vLLM provider (vllm-tailscale)",
	enable(pi: ExtensionAPI): boolean {
		try {
			pi.registerProvider(VLLM_PROVIDER, {
				baseUrl: VLLM_BASE_URL,
				apiKey: VLLM_API_KEY,
				api: "openai-completions",
				models: VLLM_MODELS,
			});
			registered = true;
			return true;
		} catch {
			// fail-open: display features are unaffected; provider simply absent
			registered = false;
			return false;
		}
	},
	disable(pi: ExtensionAPI): boolean {
		if (!registered) return true; // nothing to detach this process
		try {
			pi.unregisterProvider(VLLM_PROVIDER);
			registered = false;
			return true;
		} catch {
			return false;
		}
	},
	attached(): boolean {
		return registered;
	},
};
