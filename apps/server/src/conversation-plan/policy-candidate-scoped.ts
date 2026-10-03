import { applyInference } from "./domain";
import { currentScopedProposal } from "./events";
import type { CandidateEntry } from "./policy-candidate-entry";
import { createCandidateFactories } from "./policy-candidate-factories";
import type { CandidateRole } from "./policy-candidate-role";
import type { runCandidateVerification } from "./policy-candidate-verification";
import type { PolicyContext } from "./policy-context";
import { immediateSpikeCondition, namesCardOption } from "./policy-cues";
import { choice, moderateChoice, noul } from "./policy-scoring";
import type { Event } from "./policy-types";
import { spikeAgreementLabel } from "./validation-fields";

type Spike = NonNullable<ReturnType<typeof runCandidateVerification>>;

/** Run after verification progresses. Undefined handles/skips; true advances to scoped proposal. */
export function runScopedAssent(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
): true | undefined {
	let { message, first, events } = context;
	let { candidate, outcome } = entry;
	let { targetThread, linkedCard, role } = frame;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	try {
		let pendingScoped = targetThread?.pendingScopedChoice;
		let assentLabel = spikeAgreementLabel(candidate.quote);
		let optionAnswer = candidate.answers.option;
		let chosenAnswer = candidate.answers.chosen_option;
		if (
			role === "support" && assentLabel && candidate.start === 0
			&& !immediateSpikeCondition(message.text, candidate.end)
			&& message.author.kind === "member" && targetThread && pendingScoped
			&& !["decided", "discarded"].includes(targetThread.status)
			&& message.author.handle !== pendingScoped.proposer
			&& choice(first, "thread_target") === targetThread.id
			&& noul(first, "support") >= 0.8 && noul(candidate.answers, "support") >= 0.8
			&& optionAnswer?.type === "choice" && optionAnswer.choice === pendingScoped.optionId
			&& (optionAnswer.probabilities[pendingScoped.optionId] ?? 0) >= 0.5
			&& chosenAnswer?.type === "choice" && chosenAnswer.choice === pendingScoped.optionId
			&& (chosenAnswer.probabilities[pendingScoped.optionId] ?? 0) >= 0.6
			&& pendingScoped.scope === "spike"
			&& assentLabel.toLocaleLowerCase() === pendingScoped.label.toLocaleLowerCase()
			&& linkedCard && linkedCard.cardId === targetThread.questionnaireId
			&& linkedCard.cardId === pendingScoped.cardId
			&& linkedCard.options.filter(item =>
					item.id === pendingScoped.optionId && item.label === pendingScoped.label
				).length === 1
			&& linkedCard.options.filter(item => namesCardOption(candidate.quote, item.label)).length
				=== 1
		) {
			let proposal = currentScopedProposal(targetThread, working.events);
			if (proposal) {
				let agreed: Event = {
					...base(targetThread.id, "scoped-choice.agreed"),
					type: "scoped-choice.agreed",
					source: source("support"),
					proposalId: proposal.id,
					cardId: pendingScoped.cardId,
					optionId: pendingScoped.optionId,
					label: pendingScoped.label,
					scope: "spike",
				};
				try {
					working = applyInference(working, agreed, message);
					events.push(agreed);
					outcome.eventIds.push(agreed.id);
					outcome.status = "accepted";
					outcome.gate = "accepted";
				} catch {
					outcome.status = "review";
					outcome.gate = "scoped agreement needs review";
				}
				return undefined;
			}
		}
		return true;
	} finally {
		context.working = working;
	}
}

/** Requires assent to progress; the spike label is the earlier verification capture. */
export function runScopedProposal(
	context: PolicyContext,
	entry: CandidateEntry,
	frame: CandidateRole,
	spike: Spike,
): true | undefined {
	let { message, first, events } = context;
	let { candidate, outcome } = entry;
	let { targetThread, linkedCard, role, option, chosenOption } = frame;
	let { spikeLabel } = spike;
	let working = context.working;
	let { source, base } = createCandidateFactories(context, entry, () => working);
	try {
		if (
			(role === "support" || role === "option") && spikeLabel
			&& message.author.kind === "member" && targetThread
			&& !["decided", "discarded"].includes(targetThread.status)
			&& moderateChoice(first, "act", "proposal", 0.7)
			&& choice(first, "thread_target") === targetThread.id
			&& option && option === chosenOption && !["new", "none"].includes(option)
			&& noul(candidate.answers, "support") >= 0.8
			&& linkedCard && linkedCard.cardId === targetThread.questionnaireId
		) {
			let named = linkedCard.options.filter(item => namesCardOption(candidate.quote, item.label));
			let selected = named.length === 1 && named[0]?.id === option ? named[0] : undefined;
			if (selected && selected.label.toLocaleLowerCase() === spikeLabel.toLocaleLowerCase()) {
				if (targetThread.pendingScopedChoice?.optionId === option) {
					outcome.gate = "spike choice already pending";
					return undefined;
				}
				let scoped: Event = {
					...base(targetThread.id, "scoped-choice.proposed"),
					type: "scoped-choice.proposed",
					source: source("support"),
					cardId: linkedCard.cardId,
					optionId: selected.id,
					label: selected.label,
					scope: "spike",
				};
				try {
					working = applyInference(working, scoped, message);
					events.push(scoped);
					outcome.eventIds.push(scoped.id);
					outcome.status = "accepted";
					outcome.gate = "accepted";
				} catch {
					outcome.status = "review";
					outcome.gate = "scoped choice needs review";
				}
				return undefined;
			}
		}
		return true;
	} finally {
		context.working = working;
	}
}
