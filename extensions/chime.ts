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

// The extension factory runs multiple times per process (initial load, then
// the load bound to the resumed session, ~3 s apart). Each run gets a fresh
// ExtensionAPI whose pi.on() handlers register on that object's own extension
// record, and only the last run's object is live for the active session. A
// single module-level "already attached" flag made the second run return
// early, leaving the live object with zero handlers — agent_settled fired
// into the void while /berszi still reported "on". So: attach on every new
// object (idempotent per object), detach from all on disable. Handlers on
// orphaned objects never fire; the extra attachments are harmless.
const attachedTo = new Set<ExtensionAPI>();
const detachFns = new Map<ExtensionAPI, (() => void)[]>();

export const chimeFeature = {
	name: "chime",
	description: "terminal bell: rings when the agent settles, and when pi asks a question",
	enable(pi: ExtensionAPI): boolean {
		if (attachedTo.has(pi)) return true; // already attached to this object (idempotent)
		const offs: (() => void)[] = [];
		try {
			offs.push(pi.on("agent_settled", () => chime()));
			offs.push(pi.on("ui_prompt_start", () => chime()));
		} catch {
			for (const off of offs) {
				try {
					off();
				} catch {
					/* partial attach: best-effort rollback */
				}
			}
			return false;
		}
		attachedTo.add(pi);
		detachFns.set(pi, offs);
		return true;
	},
	disable(_pi: ExtensionAPI): boolean {
		for (const offs of detachFns.values()) {
			for (const off of offs) {
				try {
					off();
				} catch {
					/* already gone */
				}
			}
		}
		attachedTo.clear();
		detachFns.clear();
		return true;
	},
	attached(): boolean {
		return attachedTo.size > 0;
	},
};
