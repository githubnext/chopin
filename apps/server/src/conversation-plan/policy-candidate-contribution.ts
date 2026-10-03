import type { ConversationPlan } from "@chopin/protocol";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { PolicyContext } from "./policy-context";
import { COMMA_ALTERNATIVES, namesCardOption } from "./policy-cues";
import { optionIdFor, stableId } from "./policy-identity";
import { choice, moderateChoice, noul } from "./policy-scoring";
import type { Event } from "./policy-types";

/** Invoke only for the captured option/reason/constraint role; a result progresses without application. */
export function runContribution(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): { proposed: Event | undefined } | undefined {
	let { input, channelId, message, first } = context;
	let { index, candidate, outcome } = entry;
	let { thread, option, pending, qualifiedPending, role } = frame;
	let { optionGroup } = context.candidateRun!;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	let proposed: Event | undefined = undefined;

	if (
		role === "option"
		&& (COMMA_ALTERNATIVES.test(candidate.quote.trim())
			|| /^(?:what|which|who|where|when|why|how)\b[^?]*\?$/i.test(candidate.quote.trim())
			|| /\b[\p{L}][\p{L}\p{N}-]*\s+is\s+[^.!?]{1,120}\s+but\s+[^.!?]{1,120}[.!?]?$/iu
				.test(candidate.quote.trim()))
	) {
		outcome.status = "review";
		outcome.gate = "option source contains a question, group, or contrastive evaluation";
		return undefined;
	}
	if (!thread) {
		outcome.status = "review";
		outcome.gate = "contribution target needs review";
		return undefined;
	}
	if (
		role === "option" && message.author.kind === "member"
		&& moderateChoice(first, "act", "proposal", 0.7)
		&& option && !["new", "none"].includes(option)
	) {
		let card = input.linkedCards?.get(thread.id);
		let named = card && card.cardId === thread.questionnaireId
			? card.options.filter(item => namesCardOption(candidate.quote, item.label))
			: [];
		if (named.length === 1 && named[0]?.id === option) {
			outcome.status = "review";
			outcome.gate = "proposal names an existing card option";
			return undefined;
		}
	}
	// The new group has no prior contributions; repeated labels were skipped above.
	if (!optionGroup && noul(candidate.answers, "duplicate") >= 0.8) {
		outcome.gate = "duplicate contribution";
		return undefined;
	}
	let type = `${role}.added` as "option.added" | "reason.added" | "constraint.added";
	let relation = qualifiedPending && role === "constraint"
		? "qualifies"
		: choice(candidate.answers, "relation");
	let existingOption = qualifiedPending && role === "constraint"
		? pending?.optionId
		: option && !["new", "none"].includes(option)
				&& thread.contributions.some((item) => item.id === option && item.kind === "option")
		? option
		: undefined;
	proposed = {
		...base(thread.id, type),
		type,
		source: source(role as ConversationPlan.SourceRole),
		contribution: {
			id: role === "option"
				? optionIdFor(channelId, message.id, index, message.ts)
				: stableId(channelId, message.id, index, "contribution"),
			text: candidate.quote,
			authoring: "quoted",
			targetId: existingOption ?? thread.id,
			...(["supports", "challenges", "qualifies"].includes(relation ?? "")
				? { relation: relation as "supports" | "challenges" | "qualifies" }
				: {}),
		},
	};

	return { proposed };
}
