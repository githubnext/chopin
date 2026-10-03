import type { ConversationPlan } from "@chopin/protocol";

export type ConversationAnnouncementSummary = {
	revision: number;
	events: number;
	failedMessages: string[];
};

export function advanceConversationAnnouncement(
	previous: ConversationAnnouncementSummary | undefined,
	state: ConversationPlan.State | undefined,
): { summary?: ConversationAnnouncementSummary; message?: string } {
	if (!state) return {};
	let failedMessages = state.queue.filter(item => item.status === "failed")
		.map(item => item.messageId);
	let summary = { revision: state.revision, events: state.events.length, failedMessages };
	if (!previous || state.revision <= previous.revision) return { summary };
	if (failedMessages.some(messageId => !previous.failedMessages.includes(messageId))) {
		return { summary, message: "Message analysis failed. You can retry from Chat." };
	}
	if (state.events.length > previous.events) {
		let latest = state.events.at(-1);
		if (latest?.type === "thread.opened" || latest?.type === "card.linked") return { summary };
		return { summary, message: "A conversation card was updated." };
	}
	return { summary };
}
