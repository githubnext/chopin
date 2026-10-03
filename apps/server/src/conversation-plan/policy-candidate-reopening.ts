import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { stableId } from "./policy-identity";
import type { Event } from "./policy-types";
import { directReopening } from "./policy-cues";
import { noul } from "./policy-scoring";

/** Invoke only for matching captured reopening; a result progresses without ordinary application. */
export function runReopening(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { channelId, message, first, reviews } = context;
	let { thread } = frame;
	let { index, candidate, outcome } = entry;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;

	if (
		thread?.status === "decided" && message.author.kind === "member"
		&& noul(first, "reopening") >= 0.8
		&& noul(candidate.answers, "reopening") >= 0.8 && directReopening(candidate.quote)
	) {
		if (reviews.some((item) => item.kind === "reopening" && item.targetId === thread.id)) {
			outcome.status = "review";
			outcome.gate = "reopening review already proposed from this message";
			return undefined;
		}
		let id = stableId(channelId, message.id, index, "reopening-candidate");
		proposed = {
			...base(thread.id, "candidate.proposed"),
			type: "candidate.proposed",
			source: source("reopening"),
			candidate: { id, kind: "reopening", text: candidate.quote },
		};
		reviews.push({ id, kind: "reopening", targetId: thread.id });
	} else {
		outcome.status = "review";
		outcome.gate = "reopening needs review";
	}

	return { proposed };
}
