import * as Service from "../plan/service";
import { FollowthroughCoordinator } from "./coordinator";
import { resultEvidence, reviewInstruction } from "./source";
import type { Instruction as ServerInstruction } from "../chat/server-instruction";
import type { Followthrough } from "../storage/followthrough";
import type { Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

export function createFollowthrough(options: {
	agent: boolean;
	storage: StorageAdapter;
	lease: () => Lease;
	opened: (channelId: string) => Service.Plan | undefined;
	unavailable: (channelId: string) => boolean;
	attached: (channelId: string) => Promise<boolean>;
	instruct: (
		channelId: string,
		compose: (plan: Service.Plan) => ServerInstruction | undefined,
	) => Promise<boolean>;
	changed: (receipt: Followthrough) => void;
	error: (error: unknown) => void;
}) {
	return new FollowthroughCoordinator({
		store: options.storage.followthrough,
		lease: options.lease,
		changed: options.changed,
		error: options.error,
		blocked: receipt => {
			let current = options.opened(receipt.channelId);
			return current && Service.implementationActive(current) ? "document-locked" : undefined;
		},
		async inspect(receipt) {
			if (!options.agent) return { status: "deferred", reason: "planner-off" };
			if (options.unavailable(receipt.channelId)) {
				return { status: "skipped", reason: "scope-changed" };
			}
			if (!await options.attached(receipt.channelId)) {
				return { status: "deferred", reason: "remote-unavailable" };
			}
			let evidence = await resultEvidence(options.storage, receipt);
			if (!evidence) return { status: "skipped", reason: "scope-changed" };
			let current = options.opened(receipt.channelId);
			if (!current) return { status: "deferred", reason: "planner-unavailable" };
			return Service.exclusive(current, async () => {
				if (Service.implementationActive(current)) {
					return { status: "deferred", reason: "document-locked" } as const;
				}
				let context = {
					planRevision: current.revision,
					sourceHash: Service.sourceHash(Service.source(current)),
				};
				let decisions = [...current.records.values()].slice(-40).map(record => ({
					id: record.id,
					status: record.status,
					questions: record.definition.questions.map(question => question.question),
					answers: record.answers,
				}));
				return {
					status: "ready",
					context,
					text: reviewInstruction(evidence, { planRevision: current.revision, decisions }),
				} as const;
			});
		},
		async start(receipt, about) {
			if (!options.agent) return "planner-off";
			if (!await options.attached(receipt.channelId)) return "remote-unavailable";
			let reason = "owner-unavailable";
			let accepted = await options.instruct(receipt.channelId, current => {
				if (Service.implementationActive(current)) {
					reason = "document-locked";
					return;
				}
				if (current.chat.waiting.length >= 20) {
					reason = "planner-busy";
					return;
				}
				return {
					handle: "Chopin",
					text: "Review the published result in the current parent context.",
					said: receipt.kind === "research"
						? "Reviewing research findings with the document"
						: "Reviewing investigation findings with the document",
					about,
				};
			});
			return accepted ? true : reason;
		},
	});
}
