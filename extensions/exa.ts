import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — exa feature (pi-exa uses the Exa API key, from day one)
 *
 * Two jobs, both defaulting on:
 *
 * 1. The flag — pi-exa's MCP tools (web_search_exa, web_fetch_exa) connect
 *    to the remote MCP at mcp.exa.ai WITHOUT a key unless `mcpUseApiKey` is
 *    true in <agent dir>/pi-exa.json — keyless, Exa serves the anonymous
 *    free tier and its rate limit. enable() sets the flag (preserving every
 *    other pi-exa config field); disable() clears it.
 *
 * 2. The first-launch key prompt — the key itself lives in auth.json
 *    (provider "exa"), as set by pi-exa's own /exa-login. On every
 *    machine where it is missing, the first interactive session start
 *    prompts for it (once per pi process; 2-minute auto-dismiss), and
 *    stores it exactly like /exa-login does (0600, other providers
 *    preserved). berszi lists its extension first in the package
 *    manifest and pi runs session_start handlers sequentially, so the
 *    key is in place before pi-exa's own handler makes the first MCP
 *    connection — the first call is already keyed, no keyless client
 *    is ever cached. Non-interactive runs (print mode) never prompt;
 *    they announce that /exa-login is needed. EXA_API_KEY env var
 *    counts as "key present".
 *
 * The key never leaves the machine: it is typed into the dialog (which
 * pi does not persist to the session transcript) and stored in
 * auth.json. Keep the key in a password manager — one paste per
 * machine, then nothing.
 */

const PI_EXA_CONFIG_FILE = join(getAgentDir(), "pi-exa.json");
const AUTH_PATH = join(getAgentDir(), "auth.json");
const KEY_PROMPT_TIMEOUT_MS = 120_000;

interface PiExaConfig {
	enabled?: boolean;
	mcpUseApiKey?: boolean;
	deepSearchEnabled?: boolean;
	advancedSearchEnabled?: boolean;
	[key: string]: unknown;
}

function readPiExaConfig(): PiExaConfig {
	try {
		return JSON.parse(readFileSync(PI_EXA_CONFIG_FILE, "utf-8")) as PiExaConfig;
	} catch {
		return {};
	}
}

function writePiExaConfig(config: PiExaConfig): boolean {
	try {
		mkdirSync(dirname(PI_EXA_CONFIG_FILE), { recursive: true });
		writeFileSync(PI_EXA_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

function setMcpUseApiKey(on: boolean): boolean {
	const config = readPiExaConfig();
	if (config.mcpUseApiKey === on) {
		return true; // already in the desired state
	}
	return writePiExaConfig({ ...config, mcpUseApiKey: on });
}

/** Same check pi-exa performs: stored credential, else the env var. */
function hasExaKey(): boolean {
	if (process.env.EXA_API_KEY) return true;
	try {
		const data = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
		return data?.exa?.type === "api_key" && Boolean(data.exa.key);
	} catch {
		return false;
	}
}

/** Mirrors pi-exa's writeExaCredential: merge into auth.json, mode 0600. */
function storeExaKey(key: string): boolean {
	try {
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
		} catch {
			/* first credential on this machine */
		}
		data.exa = { type: "api_key", key };
		writeFileSync(AUTH_PATH, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

let flagWritten = false;
let featureOn = false;
let hooksRegistered = false;
let promptedThisProcess = false;

export const exaFeature = {
	name: "exa",
	description:
		"pi-exa uses the Exa API key — the MCP key flag is forced on, and the first launch on a keyless machine prompts for the key once",
	enable(pi: ExtensionAPI): boolean {
		featureOn = true;
		flagWritten = setMcpUseApiKey(true);
		if (hooksRegistered) return flagWritten;
		hooksRegistered = true;

		pi.on("session_start", async (_event, ctx) => {
			if (!featureOn || hasExaKey()) return;
			const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui?.notify?.(message, type);
				} catch {
					/* non-interactive */
				}
			};
			if (!ctx.hasUI) {
				// print/CI: never prompt, announce once per process
				if (!promptedThisProcess) {
					promptedThisProcess = true;
					notify(
						"berszi: exa key missing — run /exa-login in the UI (or set EXA_API_KEY); Exa MCP runs keyless until then",
						"warning",
					);
				}
				return;
			}
			if (promptedThisProcess) return;
			promptedThisProcess = true;
			const key = await ctx.ui.input(
				"pi-berszi: Exa API key not found on this machine",
				"paste it from your password manager (dismiss → run /exa-login later)",
				{ timeout: KEY_PROMPT_TIMEOUT_MS },
			);
			if (!key) {
				notify("berszi: no Exa key — Exa MCP runs keyless (free tier) until you run /exa-login", "warning");
				return;
			}
			if (storeExaKey(key.trim())) {
				notify("berszi: Exa API key stored — pi-exa uses it from this first call on (paid tier)");
			} else {
				notify("berszi: could not write auth.json (permissions?) — run /exa-login instead", "error");
			}
		});

		return flagWritten;
	},
	disable(_pi: ExtensionAPI): boolean {
		featureOn = false;
		flagWritten = setMcpUseApiKey(false);
		return flagWritten;
	},
	attached(): boolean {
		return flagWritten;
	},
};
