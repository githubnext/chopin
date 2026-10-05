import type { ConversationPlan } from "@chopin/protocol";
import type { Group, Message } from "./model";

export type ResearchTranscriptItem = Group | {
	kind: "research";
	offer: ConversationPlan.ResearchOffer;
};

/** Keep offer keys at one React parent while positioning them after their latest source. */
export function researchTranscript(
	groups: Group[],
	offers: readonly ConversationPlan.ResearchOffer[],
): ResearchTranscriptItem[] {
	let byMessage = new Map<string, ConversationPlan.ResearchOffer[]>();
	for (let offer of offers) {
		if (offer.workflow && !offer.workflow.published) continue;
		let id = offer.workflow?.placementMessageId ?? offer.source.messageId;
		byMessage.set(id, [...byMessage.get(id) ?? [], offer]);
	}
	let items: ResearchTranscriptItem[] = [];
	for (let group of groups) {
		if (group.kind !== "messages" || group.queued) {
			items.push(group);
			continue;
		}
		let messages: Message[] = [];
		for (let message of group.messages) {
			messages.push(message);
			let following = byMessage.get(message.id);
			if (!following) continue;
			items.push({ ...group, messages });
			messages = [];
			for (let offer of following) items.push({ kind: "research", offer });
		}
		if (messages.length) items.push({ ...group, messages });
	}
	return items;
}
