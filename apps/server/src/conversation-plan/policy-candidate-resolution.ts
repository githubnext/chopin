import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import type { Event } from "./policy-types";
import { applyInference } from "./domain";
import { directResolution } from "./policy-cues";
import { choice, noul } from "./policy-scoring";
import { effectivePending } from "./preference";

/** Invoke only for matching captured resolution; a result progresses without ordinary application. */
export function runResolution(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { input, message, first, events } = context;
	let { thread, strongRecommendation } = frame;
	let { competingMessageTargets } = context.candidateRun!;
	let { candidate, outcome } = entry;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;
	try {
		let marker = noul(first, "explicit_resolution");
		let follow = noul(candidate.answers, "explicit_resolution");
		let credible = message.author.kind === "member"
			&& ((directResolution(candidate.quote)
				&& (marker >= 0.8 && follow >= 0.85 || choice(first, "act") === "commitment"))
				|| strongRecommendation);
		if (!credible) {
			outcome.status = "review";
			outcome.gate = "settle authority unclear";
			return undefined;
		}
		if (!thread || thread.status === "decided" || thread.status === "discarded") {
			outcome.status = "review";
			outcome.gate = "settle target needs review";
			return undefined;
		}
		let chosen = choice(candidate.answers, "chosen_option");
		let card = input.linkedCards?.get(thread.id);
		let cardOption = card && card.cardId === thread.questionnaireId
			? card.options.find(item => item.id === chosen)
			: undefined;
		let chosenOption = chosen
				&& thread.contributions.some((item) => item.id === chosen && item.kind === "option")
			? chosen
			: cardOption?.id;
		if (!chosenOption || /\b(?:not|don't|do not|without)\b/i.test(candidate.quote)) {
			outcome.status = "review";
			outcome.gate = "chosen option needs review";
			return undefined;
		}
		let pending = effectivePending(thread, working.events);
		if (pending || competingMessageTargets.has(thread.id)) {
			let sameOption = pending?.optionId === chosenOption
				&& !competingMessageTargets.has(thread.id);
			outcome.status = sameOption ? "ignored" : "review";
			outcome.gate = sameOption ? "settle already pending" : "competing choice needs review";
			return undefined;
		}
		if (cardOption && !thread.contributions.some(item => item.id === cardOption.id)) {
			let added: Event = {
				...base(thread.id, "option.added"),
				type: "option.added",
				source: source("option"),
				contribution: {
					id: cardOption.id,
					text: cardOption.label,
					authoring: "scribe",
					targetId: thread.id,
				},
			};
			try {
				let staged = applyInference(working, added, message);
				let stagedThread = staged.threads.find(item => item.id === thread.id)!;
				let suggested: Event = {
					...base(thread.id, "settle.suggested"),
					type: "settle.suggested",
					observedThreadVersion: stagedThread.version,
					source: source("resolution"),
					optionId: cardOption.id,
				};
				working = applyInference(staged, suggested, message);
				events.push(added, suggested);
				outcome.eventIds.push(added.id, suggested.id);
				outcome.status = "accepted";
				outcome.gate = "accepted";
			} catch {
				outcome.status = "review";
				outcome.gate = "linked card choice could not be suggested";
			}
			return undefined;
		}
		proposed = {
			...base(thread.id, "settle.suggested"),
			type: "settle.suggested",
			source: source("resolution"),
			optionId: chosenOption,
		};

		return { proposed };
	} finally {
		context.working = working;
	}
}
