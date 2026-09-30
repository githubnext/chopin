import { currentScopedProposal } from "./events";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { namesCardOption, namesStanceOption } from "./policy-cues";
import { stableId } from "./policy-identity";
import { choice, noul } from "./policy-scoring";
import type { Event } from "./policy-types";

/** Invoke only for captured support/objection; a result progresses without application. */
export function runStance(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { channelId, message, first, reviews } = context;
	let { index, candidate, outcome } = entry;
	let { thread, option, linkedCard, chosenOption } = frame;
	let role = frame.role as "support" | "objection";
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;

	if (!thread || message.author.kind !== "member") {
		outcome.status = "review";
		outcome.gate = "stance target or human authority unclear";
		return undefined;
	}
	if (
		thread.status === "decided" && role === "objection"
		&& noul(candidate.answers, "material_objection") >= 0.68
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
		let existingOption = option && !["new", "none"].includes(option)
				&& thread.contributions.some((item) => item.id === option && item.kind === "option")
			? option
			: undefined;
		if (linkedCard) {
			let named = linkedCard.options.filter(item => namesStanceOption(candidate.quote, item.label));
			let selected = named.length === 1 ? named[0] : undefined;
			let unique = selected
				&& !linkedCard.options.some(item =>
					item.id !== selected.id
					&& (namesCardOption(item.label, selected.label)
						|| namesCardOption(selected.label, item.label))
				)
				&& thread.contributions.some(item =>
					item.kind === "option" && item.id === selected.id
					&& item.text === selected.label
				);
			if (
				!selected || !unique || linkedCard.cardId !== thread.questionnaireId
				|| choice(first, "thread_target") !== thread.id
			) existingOption = undefined;
			else if (existingOption && existingOption !== selected.id) {
				existingOption = undefined;
			} else if (!existingOption) {
				if (
					["none", selected.id].includes(
						candidate.answers.option?.type === "choice"
							? candidate.answers.option.choice
							: "none",
					)
					&& ["none", selected.id].includes(
						candidate.answers.chosen_option?.type === "choice"
							? candidate.answers.chosen_option.choice
							: "none",
					)
				) existingOption = selected.id;
			}
		}
		if (chosenOption && chosenOption !== "none" && chosenOption !== existingOption) {
			existingOption = undefined;
		}
		let scopedProposalId: string | null = null;
		let scoped = thread.pendingScopedChoice;
		let participant = message.author.handle;
		if (
			role === "objection" && scoped?.scope === "spike"
			&& thread.questionnaireId === scoped.cardId
			&& choice(candidate.answers, "option") === scoped.optionId
			&& choice(candidate.answers, "chosen_option") === scoped.optionId
			&& linkedCard?.cardId === scoped.cardId
			&& linkedCard.options.some(item => item.id === scoped.optionId && item.label === scoped.label)
		) {
			let proposal = currentScopedProposal(thread, working.events);
			if (
				proposal && (participant === scoped.proposer
					|| working.events.some(item =>
						item.type === "scoped-choice.agreed" && item.proposalId === proposal.id
						&& item.source.author.kind === "member"
						&& item.source.author.handle === participant
					))
			) scopedProposalId = proposal.id;
		}
		proposed = {
			...base(thread.id, "stance.changed"),
			type: "stance.changed",
			source: source(role),
			position: role === "support" ? "support" : "oppose",
			optionId: existingOption,
			scopedProposalId,
		};
	}

	return { proposed };
}
