import { contractId as id } from "./contract-support";
import type { CreateResearchWorkspace, Lease } from "./model";

export function researchWorkspace(
	channelId: string,
	createdBy: string,
	lease: Lease,
	overrides: Partial<CreateResearchWorkspace> = {},
): CreateResearchWorkspace {
	return {
		id: id("research-workspace"),
		channelId,
		title: "API compatibility research",
		proposedQuestion: "Which API contracts changed?",
		origin: "sidebar",
		createdBy,
		idempotencyKey: id("create-research"),
		fingerprint: id("research-fingerprint"),
		now: new Date("2026-01-07T03:04:05.000Z"),
		lease,
		...overrides,
	};
}
