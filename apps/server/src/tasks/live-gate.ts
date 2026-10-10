import { askJev } from "../conversation-plan/jev";
import { sourcesDiffer } from "./live-sync";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { LiveClassifier, LiveDelta } from "./live-sync";

export type JevAsk = (request: JevRequest) => Promise<JevResult>;

const MAX_DIFF = 4_000;

/** Lines only in one side, in document order, as a compact -/+ listing bounded to a few KB. */
export function changedLines(before: string, after: string): string {
	let count = (text: string) => {
		let counts = new Map<string, number>();
		for (let line of text.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
		return counts;
	};
	let kept = count(after);
	let prior = count(before);
	let side = (text: string, other: Map<string, number>, mark: string) => {
		let seen = new Map(other);
		let out: string[] = [];
		for (let line of text.split("\n")) {
			let left = seen.get(line) ?? 0;
			if (left > 0) seen.set(line, left - 1);
			else if (line.trim()) out.push(`${mark} ${line}`);
		}
		return out;
	};
	let diff = [...side(before, kept, "-"), ...side(after, prior, "+")].join("\n");
	return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
}

/**
 * Asks Jev whether a document change should alter the built software. Fails open to a plain
 * source comparison on any Jev error or timeout; the prototype prefers rebuilding.
 */
export function jevGate(ask: JevAsk): LiveClassifier {
	return {
		classify: async (delta: LiveDelta) => {
			if (delta.source === delta.baseSource) return false;
			try {
				let result = await ask({
					state: { changes: changedLines(delta.baseSource, delta.source) },
					questions: {
						rebuild: {
							type: "noul",
							instructions:
								"Does this change to the document alter what the software should do or look like, so the code needs to change? Lines marked - were removed and lines marked + were added.",
							criteria: {
								true: "The change alters required behavior, appearance, or structure.",
								false:
									"The change only affects wording, whitespace, punctuation, or other non-functional text.",
							},
						},
					},
				});
				let found = result.answers.rebuild;
				if (found?.type !== "noul" || !Number.isFinite(found.noul)) throw new Error("invalid");
				return found.noul >= 0.5;
			} catch {
				return sourcesDiffer.classify(delta);
			}
		},
	};
}

/** The Jev-backed gate when Jev is configured, otherwise the plain source comparison. */
export function liveClassifier(
	config: { model: string; timeoutMs: number } | undefined,
	ask: typeof askJev = askJev,
): LiveClassifier {
	if (!config || !(process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY)) return sourcesDiffer;
	return jevGate(request => ask(request, { model: config.model, timeoutMs: config.timeoutMs }));
}
