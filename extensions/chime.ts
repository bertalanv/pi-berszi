import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — chime feature (terminal bell)
 *
 * Rings the terminal bell (BEL, \x07) at the two moments where a human
 * is actually needed, so a backgrounded pi session — especially over
 * SSH — gets your attention:
 *   agent_settled   — the response is finished and pi waits for input
 *   ui_prompt_start — pi is showing a blocking prompt (question / confirm / input)
 *
 * The bell is the right mechanism here, not a sampled sound: over SSH a
 * sound file played on the remote host (e.g. via afplay) is never heard
 * by you — the only audio that reaches you is what your local terminal
 * plays for BEL (or the title flash, depending on your terminal's
 * settings). Locally, the bell works the same way. It is
 * cross-platform, needs no assets, and is a single byte on the same
 * stdout stream the TUI already owns: the terminal handles it
 * out-of-band, so it cannot disturb frame rendering. Guarded by isTTY:
 * in non-interactive/piped runs there is no terminal to ring, and no
 * stray byte is written into the pipe.
 */

function chime(): void {
	if (!process.stdout.isTTY) return; // no terminal: nothing to ring
	try {
		process.stdout.write("\x07");
	} catch {
		// never break the session over a bell
	}
}

const detachFns: (() => void)[] = [];
let attachedNow = false;

export const chimeFeature = {
	name: "chime",
	description: "terminal bell: rings when the agent settles, and when pi asks a question",
	enable(pi: ExtensionAPI): boolean {
		if (attachedNow) return true; // idempotent across toggles in one process
		try {
			detachFns.push(pi.on("agent_settled", () => chime()));
			detachFns.push(pi.on("ui_prompt_start", () => chime()));
			attachedNow = true;
			return true;
		} catch {
			for (const off of detachFns.splice(0)) {
				try {
					off();
				} catch {
					/* partial attach: best-effort rollback */
				}
			}
			attachedNow = false;
			return false;
		}
	},
	disable(_pi: ExtensionAPI): boolean {
		for (const off of detachFns.splice(0)) {
			try {
				off();
			} catch {
				/* already gone */
			}
		}
		attachedNow = false;
		return true;
	},
	attached(): boolean {
		return attachedNow;
	},
};
