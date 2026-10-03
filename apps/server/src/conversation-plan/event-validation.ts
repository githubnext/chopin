import type { ConversationPlan } from "@chopin/protocol";
import { ULID } from "@chopin/dialect";
import { limits as questionLimits } from "@chopin/question";
import { assertSourceShape } from "./sources";
import { assertCorrectionChange } from "./correction-validation";
import {
	actor,
	id,
	knownKeys,
	MAX_EVENTS,
	record,
	spikeAgreementLabel,
	spikePreferenceLabel,
	text,
	version,
} from "./validation-fields";

export function assertEventShape(value: unknown): asserts value is ConversationPlan.Event {
	let event = record(value);
	let base = ["id", "type", "threadId", "observedThreadVersion", "origin", "actor", "at"];
	id(event.id);
	id(event.threadId);
	version(event.observedThreadVersion);
	version(event.at);
	actor(event.actor);
	if (!["classifier", "planner", "human"].includes(event.origin as string)) {
		throw new Error("invalid event origin");
	}
	let kind = (event.actor as { kind: string }).kind;
	if (
		(event.origin === "classifier" && kind !== "classifier")
		|| (event.origin === "planner" && kind !== "agent")
		|| (event.origin === "human" && kind !== "member")
	) throw new Error("event origin and actor disagree");
	if (event.source !== undefined) assertSourceShape(event.source);
	let humanExcerpt = event.origin === "human"
		&& ["option.added", "reason.added", "constraint.added"].includes(event.type as string)
		&& event.source !== undefined
		&& (event.contribution as { authoring?: unknown } | undefined)?.authoring === "quoted";
	if (
		event.origin === "human" && (!humanExcerpt && event.source !== undefined || ![
			"decision.recorded",
			"decision.reopened",
			"thread.discarded",
			"scoped-choice.saved",
			"option.added",
			"reason.added",
			"constraint.added",
			"candidate.confirmed",
			"candidate.rejected",
			"card.corrected",
		].includes(event.type as string))
	) throw new Error("human action cannot claim a message quote");
	switch (event.type) {
		case "thread.opened":
			knownKeys(event, [...base, "source", "question"]);
			if (event.source === undefined) {
				if (event.origin !== "planner") throw new Error("opening requires a question source");
			} else assertSourceShape(event.source);
			text(event.question, event.source === undefined ? 1_000 : 500);
			break;
		case "option.added":
		case "reason.added":
		case "constraint.added": {
			knownKeys(event, [...base, "source", "contribution"]);
			let cardOption = event.type === "option.added" && event.origin === "planner"
				&& typeof event.id === "string"
				&& /^card:[0-9A-HJKMNP-TV-Z]{26}:option:[0-9A-HJKMNP-TV-Z]{26}$/.test(event.id);
			let inferred = event.origin === "classifier"
				|| (event.origin === "planner" && event.source !== undefined
					&& /^classifier:[0-9a-f]{24}$/.test(event.id as string));
			if (inferred) {
				assertSourceShape(event.source);
				if (event.origin === "planner" && event.source.author.kind !== "agent") {
					throw new Error("Planner quote must come from an agent message");
				}
			} else if (
				!humanExcerpt && (event.type !== "option.added"
					|| event.source !== undefined && !cardOption)
			) {
				throw new Error("only card options can omit a source");
			}
			let contribution = record(event.contribution);
			knownKeys(contribution, ["id", "text", "authoring", "targetId", "relation"]);
			id(contribution.id);
			if (cardOption && !String(event.id).endsWith(`:option:${contribution.id}`)) {
				throw new Error("card option event ID disagrees with contribution");
			}
			if (!inferred && !ULID.test(contribution.id as string)) {
				throw new Error("card option IDs must be ULIDs");
			}
			text(contribution.text);
			if (!["quoted", "scribe", "human-edited"].includes(contribution.authoring as string)) {
				throw new Error("invalid contribution authoring");
			}
			if (
				humanExcerpt && contribution.authoring !== "quoted"
				|| !inferred && !humanExcerpt && (
						(event.origin === "human" && contribution.authoring !== "human-edited")
						|| (event.origin === "planner" && contribution.authoring !== "scribe")
					)
			) throw new Error("card option authoring disagrees with origin");
			if (contribution.targetId !== undefined) id(contribution.targetId);
			if (
				contribution.relation !== undefined
				&& !["supports", "challenges", "qualifies"].includes(contribution.relation as string)
			) throw new Error("invalid contribution relation");
			break;
		}
		case "stance.changed":
			knownKeys(event, [...base, "source", "optionId", "scopedProposalId", "position"]);
			assertSourceShape(event.source);
			if (event.optionId !== undefined) id(event.optionId);
			if (event.scopedProposalId !== undefined && event.scopedProposalId !== null) {
				id(event.scopedProposalId);
			}
			if (!["support", "oppose", "neutral"].includes(event.position as string)) {
				throw new Error("invalid stance");
			}
			break;
		case "option.relabeled":
			knownKeys(event, [...base, "optionId", "label", "observedCardRevision"]);
			id(event.optionId);
			version(event.observedCardRevision);
			text(event.label, questionLimits.MAX_LABEL);
			let label = event.label as string;
			if (
				event.origin !== "planner" || label !== label.trim()
				|| /[\r\n]/.test(label)
				|| /\b(?:and|or|versus|vs\.?)\b/i.test(label)
				|| /,[^,]+,|,[^,]+\band\b/i.test(label)
				|| /(?<=[a-z0-9])\s*\/\s*(?=[a-z0-9])/i.test(label)
			) throw new Error("invalid atomic option label");
			break;
		case "thread.leaning":
			knownKeys(event, [...base, "source", "optionId"]);
			assertSourceShape(event.source);
			if (event.optionId !== undefined) id(event.optionId);
			break;
		case "card.linked":
			knownKeys(event, [...base, "questionnaireId"]);
			id(event.questionnaireId);
			if (event.origin !== "classifier") throw new Error("card link is a system event");
			break;
		case "settle.suggested":
			knownKeys(event, [...base, "source", "optionId"]);
			assertSourceShape(event.source);
			id(event.optionId);
			if (event.origin !== "classifier") throw new Error("settle suggestion is inferred");
			break;
		case "settle.agreed":
			knownKeys(event, [...base, "source", "optionId"]);
			assertSourceShape(event.source);
			id(event.optionId);
			if (event.origin !== "classifier") throw new Error("agreement is inferred");
			break;
		case "settle.deferred":
			knownKeys(event, [...base, "source", "proposalId"]);
			assertSourceShape(event.source);
			id(event.proposalId);
			if (event.origin !== "classifier" || event.source.role !== "constraint") {
				throw new Error("deferral requires a sourced constraint");
			}
			break;
		case "settle.resumed":
			knownKeys(event, [...base, "source", "proposalId", "deferredEventId"]);
			assertSourceShape(event.source);
			id(event.proposalId);
			id(event.deferredEventId);
			if (event.origin !== "classifier" || event.source.role !== "verification") {
				throw new Error("resume requires sourced verification");
			}
			break;
		case "scoped-choice.proposed":
			knownKeys(event, [...base, "source", "cardId", "optionId", "label", "scope"]);
			assertSourceShape(event.source);
			id(event.cardId);
			id(event.optionId);
			text(event.label, questionLimits.MAX_LABEL);
			if (
				event.origin !== "classifier" || event.scope !== "spike"
				|| event.source.role !== "support" || event.source.author.kind !== "member"
				|| spikePreferenceLabel(event.source.quote)?.toLocaleLowerCase()
					!== (event.label as string).toLocaleLowerCase()
			) throw new Error("invalid scoped choice proposal");
			break;
		case "scoped-choice.agreed":
			knownKeys(event, [
				...base,
				"source",
				"proposalId",
				"cardId",
				"optionId",
				"label",
				"scope",
			]);
			assertSourceShape(event.source);
			id(event.proposalId);
			id(event.cardId);
			id(event.optionId);
			text(event.label, questionLimits.MAX_LABEL);
			if (
				event.origin !== "classifier" || event.scope !== "spike"
				|| event.source.role !== "support" || event.source.author.kind !== "member"
				|| spikeAgreementLabel(event.source.quote)?.toLocaleLowerCase()
					!== (event.label as string).toLocaleLowerCase()
			) throw new Error("invalid scoped choice agreement");
			break;
		case "scoped-choice.saved": {
			knownKeys(event, [
				...base,
				"proposalId",
				"supportEventIds",
				"agreementId",
				"cardId",
				"optionId",
				"label",
				"scope",
				"sources",
				"expectedGeneration",
				"expectedLabel",
			]);
			id(event.proposalId);
			if (event.supportEventIds !== undefined) {
				if (
					!Array.isArray(event.supportEventIds) || event.supportEventIds.length < 1
					|| event.supportEventIds.length > MAX_EVENTS
					|| new Set(event.supportEventIds).size !== event.supportEventIds.length
				) throw new Error("invalid saved scoped choice source IDs");
				for (let sourceId of event.supportEventIds) id(sourceId);
			}
			if (event.agreementId !== undefined) id(event.agreementId);
			id(event.cardId);
			id(event.optionId);
			text(event.label, questionLimits.MAX_LABEL);
			version(event.expectedGeneration);
			if (event.expectedLabel !== undefined) text(event.expectedLabel, questionLimits.MAX_LABEL);
			if (
				event.origin !== "human" || event.scope !== "spike"
				|| !Array.isArray(event.sources)
				|| (event.supportEventIds === undefined
					? event.sources.length !== (event.agreementId === undefined ? 1 : 2)
					: event.agreementId !== undefined
						|| event.sources.length !== event.supportEventIds.length)
			) throw new Error("invalid saved scoped choice");
			let members = new Set<string>();
			for (let source of event.sources) {
				assertSourceShape(source);
				if (source.role !== "support" || source.author.kind !== "member") {
					throw new Error("invalid saved scoped choice source");
				}
				if (event.supportEventIds !== undefined) {
					if (members.has(source.author.handle)) throw new Error("duplicate scoped supporter");
					members.add(source.author.handle);
				}
			}
			break;
		}
		case "thread.discarded":
			knownKeys(event, base);
			if (event.origin !== "human") throw new Error("only a person discards");
			break;
		case "decision.recorded":
			knownKeys(event, [...base, "source", "text", "optionId", "explicit"]);
			text(event.text);
			if (event.optionId !== undefined) id(event.optionId);
			if (event.explicit !== true) throw new Error("decision requires explicit resolution");
			if (event.origin !== "human") assertSourceShape(event.source);
			break;
		case "decision.reopened":
			knownKeys(event, [...base, "source", "explicit"]);
			if (event.explicit !== true) throw new Error("reopening requires explicit statement");
			if (event.origin !== "human") assertSourceShape(event.source);
			break;
		case "candidate.proposed": {
			knownKeys(event, [...base, "source", "candidate"]);
			assertSourceShape(event.source);
			let candidate = record(event.candidate);
			knownKeys(candidate, ["id", "kind", "text"]);
			id(candidate.id);
			text(candidate.text);
			if (!["resolution", "reopening"].includes(candidate.kind as string)) {
				throw new Error("invalid candidate kind");
			}
			break;
		}
		case "candidate.confirmed":
		case "candidate.rejected":
			knownKeys(event, [...base, "candidateId"]);
			id(event.candidateId);
			if (event.origin !== "human") throw new Error("candidate action requires human");
			break;
		case "card.corrected":
			knownKeys(event, [...base, "change"]);
			if (event.origin !== "human") throw new Error("card correction requires human");
			assertCorrectionChange(event.change);
			if (
				["record-decision", "confirm-candidate", "reject-candidate"].includes(event.change.kind)
			) throw new Error("invalid card correction event");
			break;
		default:
			throw new Error("invalid conversation plan event type");
	}
}
