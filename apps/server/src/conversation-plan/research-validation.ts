import type { ConversationPlan } from "@chopin/protocol";
import { assertSourceShape } from "./sources";
import { actor, id, knownKeys, record, text, version } from "./validation-fields";
import { assertResearchWorkflow } from "./research-state";

const MAX_RESEARCH_OPTION_LABEL = 160;

/** Both the Chat card and worker receive this exact, code-owned wording. */
export function renderResearchTask(
	task: ConversationPlan.ResearchTask,
	source: ConversationPlan.ResearchSource,
): string {
	if (task.kind === "current-cost-comparison") {
		return `Compare current costs for ${task.options[0].labelAtOffer} and ${
			task.options[1].labelAtOffer
		}. Discussion context: “${source.quote}”`;
	}
	let focus = task.options.find(item => item.id === task.focusOptionId);
	let labels = task.options.map(item => item.labelAtOffer);
	return focus
		? `Investigate current costs for ${focus.labelAtOffer}; consider ${
			task.options.filter(
				item => item.id !== focus.id,
			).map(item => item.labelAtOffer).join(", ")
		} as context. Discussion context: “${source.quote}”`
		: `Investigate current costs across ${
			labels.join(", ")
		}. Discussion context: “${source.quote}”`;
}

/** A short provider code is usable only when it uniquely resolves within this frozen task. */
export function researchNamedOptionIds(
	quote: string,
	options: readonly { id: string; labelAtOffer: string }[],
): string[] {
	let codes = options.map(
		option => [
			...new Set(
				option.labelAtOffer.match(/(?<![\p{L}\p{N}])[A-Z]{1,8}\d{1,4}(?![\p{L}\p{N}])/gu) ?? [],
			),
		],
	);
	let mentions = (name: string) => {
		let escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu")
			.test(quote);
	};
	return options.filter((option, index) => {
		let label = option.labelAtOffer;
		let optionCodes = codes[index]!;
		if (optionCodes.length > 1) return false;
		let code = optionCodes[0];
		return mentions(label) || !!code
				&& codes.filter(item => item.includes(code)).length === 1
				&& mentions(code);
	}).map(option => option.id);
}

export function assertResearchOfferShape(
	value: unknown,
): asserts value is ConversationPlan.ResearchOffer {
	let offer = record(value);
	knownKeys(offer, [
		"id",
		"needId",
		"contextId",
		"source",
		"brief",
		"threadId",
		"task",
		"status",
		"action",
		"workflow",
	]);
	id(offer.id);
	id(offer.needId);
	id(offer.contextId);
	let source = record(offer.source);
	knownKeys(source, ["messageId", "author", "quote", "start", "end"]);
	assertSourceShape({ ...source, role: "support" });
	if ((source.author as { kind: string }).kind !== "member") {
		throw new Error("research offer source requires a member message");
	}
	actor(source.author);
	if (offer.workflow !== undefined) {
		assertResearchWorkflow(offer.workflow, offer);
		if (offer.task !== undefined) {
			throw new Error("general research offer cannot contain a pricing task");
		}
		if (typeof offer.brief !== "string" || offer.brief.length > 2048) {
			throw new Error("invalid research brief");
		}
	} else text(offer.brief, 2048);
	if (offer.threadId !== undefined) id(offer.threadId);
	if (offer.workflow !== undefined) {
		// The shared draft and accepted snapshot own general research wording.
	} else if (offer.task === undefined) {
		if (offer.brief !== source.quote) throw new Error("research brief must equal source quote");
	} else {
		let task = record(offer.task);
		knownKeys(task, [
			"kind",
			"threadId",
			"observedEventCount",
			"observedThreadVersion",
			"options",
			"focusOptionId",
		]);
		if (task.kind !== "current-cost-comparison" && task.kind !== "current-cost-concern") {
			throw new Error("invalid research task kind");
		}
		id(task.threadId);
		version(task.observedEventCount);
		version(task.observedThreadVersion);
		if (offer.threadId !== task.threadId) throw new Error("research task thread disagrees");
		let count = task.kind === "current-cost-comparison" ? 2 : 3;
		if (
			!Array.isArray(task.options)
			|| task.options.length < count
			|| task.options.length > (task.kind === "current-cost-comparison" ? 2 : 4)
		) {
			throw new Error(
				task.kind === "current-cost-comparison"
					? "research task requires two options"
					: "research concern requires three or four options",
			);
		}
		let optionIds = new Set<string>();
		for (let value of task.options) {
			let option = record(value);
			knownKeys(option, ["id", "labelAtOffer"]);
			id(option.id);
			text(option.labelAtOffer, MAX_RESEARCH_OPTION_LABEL);
			if (
				option.labelAtOffer !== (option.labelAtOffer as string).trim()
				|| /[\r\n]/.test(option.labelAtOffer as string)
			) {
				throw new Error("invalid research option label");
			}
			optionIds.add(option.id as string);
		}
		if (optionIds.size !== task.options.length) throw new Error("duplicate research task option");
		if (task.kind === "current-cost-comparison") {
			if (task.focusOptionId !== undefined) throw new Error("invalid research task focus");
		} else {
			if (task.focusOptionId !== undefined) {
				id(task.focusOptionId);
				if (!optionIds.has(task.focusOptionId as string)) {
					throw new Error("invalid research task focus");
				}
			}
			let named = researchNamedOptionIds(
				source.quote as string,
				task.options as Array<{ id: string; labelAtOffer: string }>,
			);
			if (named.length > 1 || task.focusOptionId !== named[0]) {
				throw new Error("research task focus is not grounded in its source");
			}
		}
		if (
			offer.brief !== renderResearchTask(
				task as ConversationPlan.ResearchTask,
				source as ConversationPlan.ResearchSource,
			)
		) throw new Error("research brief must match task and source");
	}
	if (!["offered", "dismissed", "accepted"].includes(offer.status as string)) {
		throw new Error("invalid research offer status");
	}
	if (offer.status === "offered") {
		if (offer.action !== undefined) throw new Error("unacted research offer has an action");
		return;
	}
	let action = record(offer.action);
	knownKeys(action, ["id", "kind", "actor", "principalId", "at"]);
	id(action.id);
	id(action.principalId);
	if (action.kind !== (offer.status === "accepted" ? "research" : "dismiss")) {
		throw new Error("research offer action disagrees with status");
	}
	actor(action.actor);
	if ((action.actor as { kind: string }).kind !== "member") {
		throw new Error("research offer action requires a member");
	}
	version(action.at);
}
