import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — exa feature (pi-exa MCP tools use the stored API key)
 *
 * pi-exa's MCP tools (web_search_exa, web_fetch_exa) connect to the remote
 * MCP at mcp.exa.ai WITHOUT a key unless `mcpUseApiKey` is true in
 * <agent dir>/pi-exa.json — keyless, they land on Exa's anonymous free
 * tier and hit its rate limit. This feature owns that flag: on, it sets
 * the flag to true (preserving every other pi-exa config field); off, it
 * sets it to false.
 *
 * The key itself is never touched: pi-exa reads it from auth.json (set via
 * /exa-login) or the EXA_API_KEY env var. pi-exa reads the flag lazily at
 * MCP connect time and berszi lists its own extension first in the
 * package manifest, so a fresh machine's first MCP call already carries
 * the key — a keyless client is never cached. (A runtime toggle changes
 * the file only; pi-exa's own /exa-mcp-use-api-key toggle or a /reload
 * drops its cached client so the new flag takes effect.)
 */

const PI_EXA_CONFIG_FILE = join(getAgentDir(), "pi-exa.json");

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

let flagWritten = false;

export const exaFeature = {
	name: "exa",
	description: "pi-exa MCP tools use the stored Exa API key (paid tier, not the keyless free one)",
	enable(_pi: ExtensionAPI): boolean {
		const config = readPiExaConfig();
		if (config.mcpUseApiKey === true) {
			flagWritten = true; // already on (e.g. via /exa-mcp-use-api-key)
			return true;
		}
		flagWritten = writePiExaConfig({ ...config, mcpUseApiKey: true });
		return flagWritten;
	},
	disable(_pi: ExtensionAPI): boolean {
		const config = readPiExaConfig();
		if (config.mcpUseApiKey !== true) {
			flagWritten = false; // already off; nothing to detach
			return true;
		}
		flagWritten = writePiExaConfig({ ...config, mcpUseApiKey: false });
		return flagWritten;
	},
	attached(): boolean {
		return flagWritten;
	},
};
