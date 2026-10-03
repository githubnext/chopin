import { applyInference } from "./domain";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { optionIdFor } from "./policy-identity";
import type { Event } from "./policy-types";
import { effectivePending } from "./preference";

/** Requires both scoped handlers to progress. Undefined handles/skips; true reaches later roles. */
export function runDirectNewChoice(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): true | undefined {
	let { channelId, message, events } = context;
	let { index, candidate, outcome } = entry;
	let { thread, directNewChoice } = frame;
	let { competingMessageTargets } = context.candidateRun!;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	try {
		if (directNewChoice && thread && events.length <= 10) {
			if (effectivePending(thread, working.events)) {
				outcome.status = "review";
				outcome.gate = "competing choice needs review";
				return undefined;
			}
			let optionId = optionIdFor(channelId, message.id, index, message.ts);
			let competing = competingMessageTargets.has(thread.id);
			let added: Event = {
				...base(thread.id, "option.added"),
				type: "option.added",
				source: source("option"),
				contribution: {
					id: optionId,
					text: candidate.quote,
					authoring: "quoted",
					targetId: thread.id,
				},
			};
			try {
				let staged = applyInference(working, added, message);
				if (!competing) {
					let stagedThread = staged.threads.find(item => item.id === thread.id)!;
					let suggested: Event = {
						...base(thread.id, "settle.suggested"),
						type: "settle.suggested",
						observedThreadVersion: stagedThread.version,
						source: source("resolution"),
						optionId,
					};
					staged = applyInference(staged, suggested, message);
					events.push(added, suggested);
					outcome.eventIds.push(added.id, suggested.id);
				} else {
					events.push(added);
					outcome.eventIds.push(added.id);
				}
				working = staged;
				outcome.status = competing ? "review" : "accepted";
				outcome.gate = competing ? "competing choice needs review" : "accepted";
			} catch {
				outcome.status = "review";
				outcome.gate = "new choice could not be suggested";
			}
			return undefined;
		}
		return true;
	} finally {
		context.working = working;
	}
}
