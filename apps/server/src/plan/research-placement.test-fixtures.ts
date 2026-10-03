import { ulid } from "@chopin/dialect";
import { hosted } from "./conversation-persistence.test-fixtures";

export async function pendingInlineResearch(
	context: Awaited<ReturnType<typeof hosted>>,
	channelId = context.channel.id,
) {
	let id = ulid();
	return context.storage.research.start({
		id,
		channelId,
		title: "Research request",
		question: "What should we research?",
		origin: "inline",
		createdBy: "U_octocat",
		turnId: ulid(),
		messageId: ulid(),
		requestId: ulid(),
		idempotencyKey: `inline-research-${id}`,
		fingerprint: `inline-research-${id}`,
		now: context.now,
		lease: context.lease,
	});
}
