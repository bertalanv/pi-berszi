import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * spotlight — chime feature (macOS system sounds)
 *
 * Plays a short system sound at the two moments where a human is
 * actually needed, so a backgrounded pi session gets your attention:
 *   agent_settled   -> Glass  (response finished, waiting for input)
 *   ui_prompt_start -> Ping   (pi is asking a question / confirmation)
 *
 * darwin-only by design: on other platforms the listeners stay
 * registered and the play call is a no-op, so the feature reads "on"
 * everywhere and simply stays silent. Sounds are the stock macOS ones
 * in /System/Library/Sounds — no assets shipped. spawn is detached,
 * unref'd and stdio-ignored: it never blocks a turn and never breaks
 * the session over a sound.
 */

const SOUNDS = {
	settled: "/System/Library/Sounds/Glass.aiff",
	prompt: "/System/Library/Sounds/Ping.aiff",
};

function chime(sound: string): void {
	if (process.platform !== "darwin" || !sound) return;
	try {
		const child = spawn("afplay", [sound], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// never break the session over a sound
	}
}

const detachFns: (() => void)[] = [];
let attachedNow = false;

export const chimeFeature = {
	name: "chime",
	description: "macOS system sounds: Glass when the agent settles, Ping when pi asks a question",
	enable(pi: ExtensionAPI): boolean {
		if (attachedNow) return true; // idempotent across toggles in one process
		try {
			detachFns.push(pi.on("agent_settled", () => chime(SOUNDS.settled)));
			detachFns.push(pi.on("ui_prompt_start", () => chime(SOUNDS.prompt)));
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
