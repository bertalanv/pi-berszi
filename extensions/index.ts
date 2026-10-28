import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { displayFeature } from "./display.js";
import { modelsFeature } from "./models.js";
import { exaFeature } from "./exa.js";

/**
 * berszi — personal pi setup bundle
 *
 * One extension that carries the author's per-machine "special needs": each
 * feature is a module exporting { name, description, enable(pi),
 * disable(pi), attached() } and is listed in FEATURES. Toggles are persisted
 * to <agent dir>/berszi-state.json, so they survive restarts and /reload.
 *
 * Add a feature: create extensions/<name>.ts exporting the shape above and
 * add it to FEATURES — status, on/off, and persistence come for free.
 *
 * Commands:
 *   /berszi                  — status of all features
 *   /berszi on | off         — all features (backward-compatible default)
 *   /berszi <feature> on|off — one feature (display, models, exa)
 *
 * Tested against pi 1.1.0.
 */

const TESTED_VERSION = "1.1";
const STATE_FILE = "berszi-state.json";

interface Feature {
	name: string;
	description: string;
	enable(pi: ExtensionAPI): boolean;
	disable(pi: ExtensionAPI): boolean;
	attached(): boolean;
}

const FEATURES: Feature[] = [displayFeature, modelsFeature, exaFeature];

interface State {
	features: Record<string, boolean>;
}

function statePath(): string {
	return join(getAgentDir(), STATE_FILE);
}

function loadState(): State {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf-8")) as Partial<State>;
		const features =
			parsed.features && typeof parsed.features === "object" && !Array.isArray(parsed.features)
				? (parsed.features as Record<string, boolean>)
				: {};
		return { features };
	} catch {
		// missing/corrupt state → defaults (every feature on)
		return { features: {} };
	}
}

function saveState(state: State): void {
	try {
		writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
	} catch {
		// fail-open: the toggle holds for this session only
	}
}

export default function berszi(pi: ExtensionAPI): void {
	const state = loadState();
	// desired: what the persisted state asks for (a feature with no saved
	// entry defaults on). attached: what actually attached this run.
	const desired = new Map<string, boolean>();
	const attached = new Map<string, boolean>();
	for (const feature of FEATURES) {
		const want = state.features[feature.name] !== false;
		desired.set(feature.name, want);
		// disabled features still go through disable(): it detaches whatever
		// an earlier factory run of this process may have attached.
		attached.set(feature.name, want ? feature.enable(pi) : feature.disable(pi));
	}

	const piVersion = String(VERSION ?? "").split(".").slice(0, 2).join(".");
	const versionNote = piVersion === TESTED_VERSION ? "" : ` (untested on pi ${piVersion})`;

	pi.on("session_start", (_event, ctx) => {
		const notify = (message: string, type: "info" | "warning" = "info") => {
			try {
				ctx.ui?.notify?.(message, type);
			} catch {
				/* non-interactive mode */
			}
		};
		// Degradation must be announced, not silent (fail-open contract).
		const failures = FEATURES.filter((f) => desired.get(f.name) && !attached.get(f.name)).map((f) => f.name);
		if (failures.length) {
			notify(`berszi: ${failures.join(", ")} could not attach (pi internals changed?)${versionNote}`, "warning");
			return;
		}
		const onNames = FEATURES.filter((f) => desired.get(f.name)).map((f) => f.name);
		if (!onNames.length) {
			notify(`berszi: off${versionNote}`);
			return;
		}
		notify(`berszi: ${onNames.join(" + ")} on${versionNote}`, piVersion === TESTED_VERSION ? "info" : "warning");
	});

	pi.registerCommand("berszi", {
		description: "berszi: on | off | <feature> on|off (no args: status)",
		handler: async (args, ctx) => {
			const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui?.notify?.(message, type);
				} catch {
					/* non-interactive mode */
				}
			};
			try {
				const words = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
				const setStatus = (feature: Feature, on: boolean): { message: string; ok: boolean } => {
					const ok = on ? feature.enable(pi) : feature.disable(pi);
					desired.set(feature.name, on);
					attached.set(feature.name, ok);
					state.features[feature.name] = on;
					saveState(state);
					if (ok) return { message: `berszi: ${feature.name} ${on ? "on" : "off"}`, ok };
					return on
						? { message: `berszi: ${feature.name} could not attach (pi internals changed?)`, ok }
						: { message: `berszi: ${feature.name} off (could not detach — pi internals changed?)`, ok };
				};
				if (!words.length) {
					const parts = FEATURES.map((f) => {
						if (!desired.get(f.name)) return `${f.name} off`;
						return attached.get(f.name) ? `${f.name} on` : `${f.name} failed`;
					});
					notify(`berszi: ${parts.join(", ")} (pi ${String(VERSION ?? "?")})`);
				} else if (words.length === 1 && (words[0] === "on" || words[0] === "off")) {
					const on = words[0] === "on";
					const results = FEATURES.map((f) => setStatus(f, on));
					const names = FEATURES.map((f) => f.name).join(" + ");
					if (results.every((r) => r.ok)) {
						notify(on ? `berszi: on — ${names}` : `berszi: off — stock ${names}`);
					} else {
						notify(`berszi: ${on ? "on" : "off"} — ${results.filter((r) => !r.ok).length} feature(s) could not switch`, "warning");
					}
				} else if (words.length === 1) {
					const feature = FEATURES.find((f) => f.name === words[0]);
					if (!feature) {
						notify(`berszi: unknown feature "${words[0]}" — features: ${FEATURES.map((f) => f.name).join(", ")}`, "error");
					} else {
						const state = !desired.get(feature.name) ? "off" : attached.get(feature.name) ? "on" : "failed";
						notify(`berszi: ${feature.name} ${state} — /berszi ${feature.name} on|off to change`);
					}
				} else if (words.length === 2 && (words[1] === "on" || words[1] === "off")) {
					const feature = FEATURES.find((f) => f.name === words[0]);
					if (!feature) {
						notify(`berszi: unknown feature "${words[0]}" — features: ${FEATURES.map((f) => f.name).join(", ")}`, "error");
					} else {
						const { message, ok } = setStatus(feature, words[1] === "on");
						notify(message, !ok ? "warning" : "info");
					}
				} else {
					notify(`berszi: usage: /berszi [on | off | <feature> on|off] — features: ${FEATURES.map((f) => f.name).join(", ")}`, "error");
				}
			} catch (err) {
				notify(`berszi: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
