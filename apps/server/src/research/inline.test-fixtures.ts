import type { ConversationPlan } from "@chopin/protocol";
import { ResearchWorkspaceService } from "./service";
import { setup } from "./test-support";

export function acceptedOffer(
	principalId: string,
	brief = "Which public evidence supports version 3?",
): ConversationPlan.ResearchOffer {
	return {
		id: "offer-lookup",
		needId: "evidence",
		contextId: "version-3",
		source: {
			messageId: "message-lookup",
			author: { kind: "member", handle: "octocat" },
			quote: brief,
			start: 0,
			end: brief.length,
		},
		brief,
		status: "accepted",
		action: {
			id: "action-lookup",
			kind: "research",
			actor: { kind: "member", handle: "octocat" },
			principalId,
			at: 1,
		},
	};
}

export async function failInitialEvidence(context: Awaited<ReturnType<typeof setup>>) {
	let [claimed] = await context.storage.jobs.claim({
		channelId: context.channelId,
		claimOwner: "failing-worker",
		count: 1,
		ttlMs: 30_000,
		now: context.advance(),
		lease: context.lease,
	});
	if (!claimed) throw new Error("initial evidence job was not claimable");
	await context.storage.jobs.fail({
		channelId: context.channelId,
		jobId: claimed.id,
		claimOwner: "failing-worker",
		claimGeneration: claimed.claimGeneration,
		reason: "internal-provider-detail",
		now: context.advance(),
		lease: context.lease,
	});
	return claimed.id;
}

export function terminalNotices(context: Awaited<ReturnType<typeof setup>>) {
	let notices: Array<{ channelId: string; id: string; text: string }> = [];
	let service = new ResearchWorkspaceService({
		storage: context.storage,
		jobs: context.jobs,
		lease: () => context.lease,
		current: async () => undefined,
		publish: () => {},
		terminalNotice: async (channelId, id, text) => {
			notices.push({ channelId, id, text });
		},
	});
	return { service, notices };
}

export function childFixture(context: Awaited<ReturnType<typeof setup>>) {
	return {
		jobs: context.jobs,
		lease: context.lease,
		now: context.advance,
		parent: context.channel,
		storage: context.storage,
	};
}
