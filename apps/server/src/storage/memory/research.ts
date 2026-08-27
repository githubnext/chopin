import { conflict, missing } from "../errors";
import { deterministicChannelId } from "../../channels/id";
import {
	RESEARCH_REPOSITORY_CHANNEL_LIMIT,
	RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT,
	RESEARCH_REPOSITORY_WORKSPACE_LIMIT,
	researchAttemptDisposition,
} from "../model";

import type {
	AppendResearchAgentMessage,
	AppendResearchAgentMessageResult,
	AppendResearchTurn,
	AppendResearchTurnResult,
	BackgroundJobDetail,
	BackgroundJobState,
	ChannelRecord,
	ConfirmResearchWorkspace,
	ConfirmResearchWorkspaceResult,
	CreateChannel,
	CreateResearchWorkspace,
	CreateResearchWorkspaceResult,
	Lease,
	LinkResearchTurnJob,
	LinkResearchTurnJobResult,
	PublishInitialResearchReport,
	PublishInitialResearchReportResult,
	ResearchJobRole,
	ResearchMessage,
	ResearchTurn,
	ResearchWorkspace,
	ResearchWorkspaceDetail,
	ResearchWorkspaceRepositoryGroup,
	ResearchWorkspaceRepositoryList,
	ResearchWorkspaceSummary,
	ResetInitialResearchAttempt,
	ResetInitialResearchAttemptResult,
	StartResearchWorkspace,
	StartResearchWorkspaceResult,
} from "../model";
import type { ResearchWorkspaceStore } from "../port";

type Options = {
	channelExists: (channelId: string) => boolean;
	channelActive: (channelId: string) => boolean;
	channel: (channelId: string) => ChannelRecord | undefined;
	channels: (repositoryId: string) => ChannelRecord[];
	userExists: (userId: string) => boolean;
	job: (channelId: string, jobId: string) => Promise<BackgroundJobDetail | undefined>;
	publication: <T>(
		execute: (access: {
			channel: (channelId: string) => ChannelRecord | undefined;
			job: (channelId: string, jobId: string) => BackgroundJobDetail | undefined;
			createAvailableChannel: (input: CreateChannel) => ChannelRecord;
		}) => T,
	) => T;
	assertLease: (lease: Lease) => void;
};

type LinkedJob = { turnId: string; role: ResearchJobRole };

function required(value: string, field: string): void {
	if (!value) throw conflict(`research ${field} must not be empty`);
}

function optional(value: string | undefined, field: string): void {
	if (value !== undefined) required(value, field);
}

function timestamp(value: Date, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw conflict(`research ${field} must be a valid timestamp`);
	}
	return new Date(value);
}

function workspace(value: ResearchWorkspace): ResearchWorkspace {
	return {
		...value,
		createdAt: new Date(value.createdAt),
		updatedAt: new Date(value.updatedAt),
	};
}

function turn(value: ResearchTurn): ResearchTurn {
	return {
		...value,
		createdAt: new Date(value.createdAt),
		updatedAt: new Date(value.updatedAt),
	};
}

function message(value: ResearchMessage): ResearchMessage {
	return { ...value, createdAt: new Date(value.createdAt) };
}

function key(parent: string, value: string): string {
	return `${parent}\u0000${value}`;
}

function compareId(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function same(left: string | undefined, right: string | undefined): boolean {
	return left === right;
}

/** Serialized, deeply-cloned research persistence for provider contract and domain tests. */
export class MemoryResearchWorkspaceStore implements ResearchWorkspaceStore {
	#options: Options;
	#workspaces = new Map<string, ResearchWorkspace>();
	#idempotency = new Map<string, string>();
	#turns = new Map<string, ResearchTurn[]>();
	#turnIds = new Map<string, ResearchTurn>();
	#turnRequests = new Map<string, string>();
	#messages = new Map<string, ResearchMessage[]>();
	#messageIds = new Map<string, ResearchMessage>();
	#agentMessagesByJob = new Map<string, ResearchMessage>();
	#nextOrdinals = new Map<string, number>();
	#nextSequences = new Map<string, number>();
	#linkedJobs = new Map<string, LinkedJob>();
	#writeTail = Promise.resolve();

	constructor(options: Options) {
		this.#options = options;
	}

	readonly create = (input: CreateResearchWorkspace): Promise<CreateResearchWorkspaceResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			required(input.idempotencyKey, "workspace idempotency key");
			required(input.fingerprint, "workspace fingerprint");
			let repeatedId = this.#idempotency.get(key(input.channelId, input.idempotencyKey));
			if (repeatedId) {
				let repeated = this.#workspaces.get(repeatedId)!;
				if (repeated.fingerprint !== input.fingerprint) {
					throw conflict(`research workspace idempotency key ${input.idempotencyKey} was reused`);
				}
				return { workspace: workspace(repeated), repeated: true };
			}
			this.#assertActiveChannel(input.channelId, input.lease);

			this.#requireUser(input.createdBy);
			required(input.id, "workspace id");
			required(input.title, "workspace title");
			required(input.proposedQuestion, "workspace proposed question");
			optional(input.originMessageId, "workspace origin message id");
			if (input.origin !== "sidebar" && input.origin !== "planner") {
				throw conflict("research workspace origin is invalid");
			}
			if (this.#workspaces.has(input.id)) {
				throw conflict(`research workspace ${input.id} already exists`);
			}
			let now = timestamp(input.now, "workspace creation time");
			let saved: ResearchWorkspace = {
				id: input.id,
				channelId: input.channelId,
				publishedChannelId: undefined,
				title: input.title,
				proposedQuestion: input.proposedQuestion,
				confirmedQuery: undefined,
				origin: input.origin,
				originMessageId: input.originMessageId,
				createdBy: input.createdBy,
				confirmedBy: undefined,
				revision: 0,
				idempotencyKey: input.idempotencyKey,
				fingerprint: input.fingerprint,
				createdAt: now,
				updatedAt: now,
			};
			this.#workspaces.set(saved.id, saved);
			this.#idempotency.set(key(saved.channelId, saved.idempotencyKey), saved.id);
			this.#turns.set(saved.id, []);
			this.#messages.set(saved.id, []);
			this.#nextOrdinals.set(saved.id, 1);
			this.#nextSequences.set(saved.id, 1);
			return { workspace: workspace(saved), repeated: false };
		});

	readonly start = (
		input: StartResearchWorkspace,
	): Promise<StartResearchWorkspaceResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			required(input.idempotencyKey, "workspace idempotency key");
			required(input.fingerprint, "workspace fingerprint");
			if (input.origin !== "inline" && input.origin !== "planner") {
				throw conflict("research workspace start origin is invalid");
			}
			if (
				input.origin === "inline" && input.originMessageId !== undefined
				|| input.origin === "planner" && !input.originMessageId
			) throw conflict("research workspace start origin message is invalid");
			let repeatedId = this.#idempotency.get(key(input.channelId, input.idempotencyKey));
			if (repeatedId) {
				let repeated = this.#workspaces.get(repeatedId)!;
				let repeatedTurn = (this.#turns.get(repeated.id) ?? [])[0];
				if (
					repeated.fingerprint !== input.fingerprint
					|| repeated.origin !== input.origin
					|| repeated.originMessageId !== input.originMessageId
					|| !repeatedTurn
					|| repeatedTurn.kind !== "initial"
				) {
					throw conflict(
						`research workspace idempotency key ${input.idempotencyKey} was reused`,
					);
				}
				return {
					workspace: workspace(repeated),
					turn: turn(repeatedTurn),
					message: message(this.#memberMessage(repeatedTurn)),
					repeated: true,
				};
			}
			this.#assertActiveChannel(input.channelId, input.lease);
			this.#requireUser(input.createdBy);
			required(input.id, "workspace id");
			required(input.title, "workspace title");
			required(input.question, "workspace question");
			required(input.turnId, "turn id");
			required(input.messageId, "message id");
			required(input.requestId, "request id");
			optional(input.createdByHandle, "creating member handle");
			if (this.#workspaces.has(input.id)) {
				throw conflict(`research workspace ${input.id} already exists`);
			}
			this.#assertNewTurn(input.turnId, input.messageId);
			let now = timestamp(input.now, "workspace start time");
			let savedWorkspace: ResearchWorkspace = {
				id: input.id,
				channelId: input.channelId,
				publishedChannelId: undefined,
				title: input.title,
				proposedQuestion: input.question,
				confirmedQuery: input.question,
				origin: input.origin,
				originMessageId: input.originMessageId,
				createdBy: input.createdBy,
				confirmedBy: input.createdBy,
				revision: 0,
				idempotencyKey: input.idempotencyKey,
				fingerprint: input.fingerprint,
				createdAt: now,
				updatedAt: now,
			};
			this.#workspaces.set(savedWorkspace.id, savedWorkspace);
			this.#idempotency.set(
				key(savedWorkspace.channelId, savedWorkspace.idempotencyKey),
				savedWorkspace.id,
			);
			this.#turns.set(savedWorkspace.id, []);
			this.#messages.set(savedWorkspace.id, []);
			this.#nextOrdinals.set(savedWorkspace.id, 1);
			this.#nextSequences.set(savedWorkspace.id, 1);
			let savedTurn = this.#newTurn({
				workspaceId: savedWorkspace.id,
				id: input.turnId,
				kind: "initial",
				requestId: input.requestId,
				fingerprint: input.fingerprint,
				question: input.question,
				requestedBy: input.createdBy,
				now,
			});
			let savedMessage = this.#newMemberMessage(
				savedWorkspace.id,
				input.messageId,
				savedTurn,
				input.createdByHandle,
				now,
			);
			return {
				workspace: workspace(savedWorkspace),
				turn: turn(savedTurn),
				message: message(savedMessage),
				repeated: false,
			};
		});

	readonly confirm = (
		input: ConfirmResearchWorkspace,
	): Promise<ConfirmResearchWorkspaceResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			required(input.requestId, "confirmation request id");
			required(input.fingerprint, "confirmation fingerprint");
			required(input.confirmedQuery, "confirmed query");
			required(input.confirmedBy, "confirming member id");
			optional(input.confirmedByHandle, "confirming member handle");
			this.#requireUser(input.confirmedBy);

			let repeated = this.#turnForRequest(found.id, input.requestId);
			if (repeated) {
				let repeatedMessage = this.#memberMessage(repeated);
				if (
					repeated.kind !== "initial"
					|| repeated.fingerprint !== input.fingerprint
					|| repeated.question !== input.confirmedQuery
					|| repeated.requestedBy !== input.confirmedBy
					|| !same(repeatedMessage.userHandle, input.confirmedByHandle)
				) throw conflict(`research request ${input.requestId} was reused with another payload`);
				return {
					workspace: workspace(found),
					turn: turn(repeated),
					message: message(repeatedMessage),
					repeated: true,
				};
			}
			this.#assertActiveChannel(input.channelId, input.lease);
			if (found.confirmedQuery !== undefined) {
				throw conflict(`research workspace ${found.id} is already confirmed`);
			}
			required(input.turnId, "turn id");
			required(input.messageId, "message id");
			this.#assertNewTurn(input.turnId, input.messageId);
			let now = timestamp(input.now, "confirmation time");
			let savedTurn = this.#newTurn({
				workspaceId: found.id,
				id: input.turnId,
				kind: "initial",
				requestId: input.requestId,
				fingerprint: input.fingerprint,
				question: input.confirmedQuery,
				requestedBy: input.confirmedBy,
				now,
			});
			let savedMessage = this.#newMemberMessage(
				found.id,
				input.messageId,
				savedTurn,
				input.confirmedByHandle,
				now,
			);
			let savedWorkspace = this.#saveWorkspace({
				...found,
				confirmedQuery: input.confirmedQuery,
				confirmedBy: input.confirmedBy,
			}, now);
			return {
				workspace: workspace(savedWorkspace),
				turn: turn(savedTurn),
				message: message(savedMessage),
				repeated: false,
			};
		});

	readonly appendTurn = (input: AppendResearchTurn): Promise<AppendResearchTurnResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			required(input.requestId, "turn request id");
			required(input.fingerprint, "turn fingerprint");
			required(input.question, "turn question");
			required(input.requestedBy, "requesting member id");
			optional(input.requestedByHandle, "requesting member handle");
			if (input.kind !== "follow-up" && input.kind !== "search-more") {
				throw conflict("research appended turn kind is invalid");
			}
			this.#requireUser(input.requestedBy);

			let repeated = this.#turnForRequest(found.id, input.requestId);
			if (repeated) {
				let repeatedMessage = this.#memberMessage(repeated);
				if (
					repeated.kind !== input.kind
					|| repeated.fingerprint !== input.fingerprint
					|| repeated.question !== input.question
					|| repeated.requestedBy !== input.requestedBy
					|| !same(repeatedMessage.userHandle, input.requestedByHandle)
				) throw conflict(`research request ${input.requestId} was reused with another payload`);
				return {
					workspace: workspace(found),
					turn: turn(repeated),
					message: message(repeatedMessage),
					repeated: true,
				};
			}
			this.#assertActiveChannel(input.channelId, input.lease);
			if (found.confirmedQuery === undefined) {
				throw conflict(`research workspace ${found.id} is not confirmed`);
			}
			required(input.turnId, "turn id");
			required(input.messageId, "message id");
			this.#assertNewTurn(input.turnId, input.messageId);
			let now = timestamp(input.now, "turn creation time");
			let savedTurn = this.#newTurn({
				workspaceId: found.id,
				id: input.turnId,
				kind: input.kind,
				requestId: input.requestId,
				fingerprint: input.fingerprint,
				question: input.question,
				requestedBy: input.requestedBy,
				now,
			});
			let savedMessage = this.#newMemberMessage(
				found.id,
				input.messageId,
				savedTurn,
				input.requestedByHandle,
				now,
			);
			let savedWorkspace = this.#saveWorkspace(found, now);
			return {
				workspace: workspace(savedWorkspace),
				turn: turn(savedTurn),
				message: message(savedMessage),
				repeated: false,
			};
		});

	readonly linkJob = (input: LinkResearchTurnJob): Promise<LinkResearchTurnJobResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			required(input.turnId, "turn id");
			required(input.jobId, "linked job id");
			if (input.role !== "evidence" && input.role !== "answer") {
				throw conflict("research job role is invalid");
			}
			let foundTurn = this.#requireTurn(found.id, input.turnId);
			let job = await this.#options.job(input.channelId, input.jobId);
			if (!job) {
				throw missing(`background job ${input.jobId} does not exist in channel ${input.channelId}`);
			}
			let type = input.role === "evidence" ? "research-evidence" : "research-answer";
			let target = `${type}:workspace:${found.id}:turn:${foundTurn.id}:${input.role}`;
			if (
				job.job.type !== type || job.job.targetKey !== target
				|| job.job.targetGeneration !== job.target.generation
			) {
				throw conflict(
					`background job ${input.jobId} is not current ${input.role} work for the turn`,
				);
			}
			this.#options.assertLease(input.lease);
			let current = input.role === "evidence"
				? foundTurn.evidenceJobId
				: foundTurn.answerJobId;
			if (current !== undefined) {
				if (current !== input.jobId) {
					throw conflict(`research turn ${foundTurn.id} already has an ${input.role} job`);
				}
				return { workspace: workspace(found), turn: turn(foundTurn), repeated: true };
			}
			let linked = this.#linkedJobs.get(input.jobId);
			if (linked) {
				throw conflict(`background job ${input.jobId} is already linked to a research turn`);
			}
			let now = timestamp(input.now, "job link time");
			let savedTurn: ResearchTurn = {
				...foundTurn,
				...(input.role === "evidence"
					? { evidenceJobId: input.jobId }
					: { answerJobId: input.jobId }),
				updatedAt: new Date(Math.max(foundTurn.updatedAt.getTime(), now.getTime())),
			};
			this.#replaceTurn(savedTurn);
			this.#linkedJobs.set(input.jobId, { turnId: savedTurn.id, role: input.role });
			let savedWorkspace = this.#saveWorkspace(found, now);
			return {
				workspace: workspace(savedWorkspace),
				turn: turn(savedTurn),
				repeated: false,
			};
		});

	readonly resetInitialAttempt = (
		input: ResetInitialResearchAttempt,
	): Promise<ResetInitialResearchAttemptResult> =>
		this.#mutate(async () => {
			this.#assertActiveChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			if (found.publishedChannelId) {
				throw conflict(`research workspace ${found.id} is already published`);
			}
			let foundTurn = (this.#turns.get(found.id) ?? [])[0];
			if (!foundTurn || foundTurn.kind !== "initial") {
				throw conflict(`research workspace ${found.id} has no initial turn`);
			}
			if (
				foundTurn.evidenceJobId !== input.expectedEvidenceJobId
				|| foundTurn.answerJobId !== input.expectedAnswerJobId
			) throw conflict(`research workspace ${found.id} changed before retry`);
			if (!foundTurn.evidenceJobId && !foundTurn.answerJobId) {
				return { workspace: workspace(found), turn: turn(foundTurn), repeated: true };
			}
			let states: BackgroundJobState[] = [];
			for (let jobId of [foundTurn.evidenceJobId, foundTurn.answerJobId]) {
				if (!jobId) continue;
				let detail = await this.#options.job(input.channelId, jobId);
				if (!detail) {
					throw missing(`background job ${jobId} does not exist in channel ${input.channelId}`);
				}
				states.push(detail.job.state);
			}
			let disposition = researchAttemptDisposition(states);
			if (disposition === "active") {
				throw conflict(`research workspace ${found.id} still has active initial work`);
			}
			if (disposition !== "retryable") {
				throw conflict(`research workspace ${found.id} has no terminal initial work`);
			}
			this.#assertActiveChannel(input.channelId, input.lease);
			let now = timestamp(input.now, "retry time");
			let savedTurn: ResearchTurn = {
				...foundTurn,
				evidenceJobId: undefined,
				answerJobId: undefined,
				updatedAt: new Date(Math.max(foundTurn.updatedAt.getTime(), now.getTime())),
			};
			this.#replaceTurn(savedTurn);
			if (foundTurn.evidenceJobId) this.#linkedJobs.delete(foundTurn.evidenceJobId);
			if (foundTurn.answerJobId) this.#linkedJobs.delete(foundTurn.answerJobId);
			let savedWorkspace = this.#saveWorkspace(found, now);
			return {
				workspace: workspace(savedWorkspace),
				turn: turn(savedTurn),
				repeated: false,
			};
		});

	readonly appendAgentMessage = (
		input: AppendResearchAgentMessage,
	): Promise<AppendResearchAgentMessageResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			required(input.id, "message id");
			required(input.turnId, "message turn id");
			required(input.sourceJobId, "message source job id");
			required(input.text, "message text");
			optional(input.userId, "message user id");
			optional(input.userHandle, "message user handle");
			if (input.userId) this.#requireUser(input.userId);
			let repeated = this.#messageIds.get(input.id)
				?? this.#agentMessagesByJob.get(input.sourceJobId);
			if (repeated) {
				if (
					repeated.workspaceId !== found.id
					|| repeated.authorKind !== "agent"
					|| repeated.turnId !== input.turnId
					|| repeated.sourceJobId !== input.sourceJobId
					|| repeated.userId !== input.userId
					|| repeated.userHandle !== input.userHandle
					|| repeated.text !== input.text
				) throw conflict(`research message ${input.id} was reused with another payload`);
				return { workspace: workspace(found), message: message(repeated), repeated: true };
			}
			let foundTurn = this.#requireTurn(found.id, input.turnId);
			if (foundTurn.answerJobId !== input.sourceJobId) {
				throw conflict(
					`research turn ${foundTurn.id} is not linked to answer job ${input.sourceJobId}`,
				);
			}
			if (!await this.#options.job(input.channelId, input.sourceJobId)) {
				throw missing(
					`background job ${input.sourceJobId} does not exist in channel ${input.channelId}`,
				);
			}
			this.#options.assertLease(input.lease);
			let now = timestamp(input.now, "message creation time");
			let sequence = this.#nextSequences.get(found.id) ?? 1;
			let savedMessage: ResearchMessage = {
				id: input.id,
				workspaceId: found.id,
				sequence,
				turnId: input.turnId,
				authorKind: "agent",
				userId: input.userId,
				userHandle: input.userHandle,
				text: input.text,
				sourceJobId: input.sourceJobId,
				createdAt: now,
			};
			this.#messages.get(found.id)!.push(savedMessage);
			this.#messageIds.set(savedMessage.id, savedMessage);
			this.#agentMessagesByJob.set(savedMessage.sourceJobId!, savedMessage);
			this.#nextSequences.set(found.id, sequence + 1);
			let savedWorkspace = this.#saveWorkspace(found, now);
			return {
				workspace: workspace(savedWorkspace),
				message: message(savedMessage),
				repeated: false,
			};
		});

	readonly publishInitialReport = (
		input: PublishInitialResearchReport,
	): Promise<PublishInitialResearchReportResult> =>
		this.#mutate(async () => {
			this.#assertChannel(input.channelId, input.lease);
			let found = this.#requireWorkspace(input.channelId, input.workspaceId);
			required(input.answerJobId, "publication answer job id");
			required(input.title, "publication title");
			let initialTurn = (this.#turns.get(found.id) ?? [])[0];
			if (
				!initialTurn
				|| initialTurn.kind !== "initial"
				|| initialTurn.answerJobId !== input.answerJobId
			) {
				throw conflict(
					`research workspace ${found.id} is not linked to initial answer job ${input.answerJobId}`,
				);
			}
			if (found.publishedChannelId) {
				let published = this.#options.channel(found.publishedChannelId);
				if (!published) {
					throw missing(`published channel ${found.publishedChannelId} does not exist`);
				}
				return { workspace: workspace(found), channel: published, repeated: true };
			}
			this.#assertActiveChannel(input.channelId, input.lease);
			let parent = this.#options.channel(input.channelId);
			if (!parent) throw missing(`channel ${input.channelId} does not exist`);
			if (parent.parentChannelId) {
				throw conflict(`channel ${parent.id} cannot parent another child`);
			}
			let answer = await this.#options.job(input.channelId, input.answerJobId);
			let target = `research-answer:workspace:${found.id}:turn:${initialTurn.id}:answer`;
			if (
				!answer
				|| answer.job.channelId !== input.channelId
				|| answer.job.type !== "research-answer"
				|| answer.job.targetKey !== target
				|| answer.job.targetGeneration !== answer.target.generation
				|| answer.job.state !== "completed"
				|| !answer.artifact
			) {
				throw conflict(`background job ${input.answerJobId} is not current completed answer work`);
			}
			return this.#options.publication(access => {
				this.#options.assertLease(input.lease);
				let currentParent = access.channel(input.channelId);
				if (!currentParent) throw missing(`channel ${input.channelId} does not exist`);
				if (currentParent.archivedAt) throw conflict(`channel ${input.channelId} is archived`);
				if (currentParent.parentChannelId) {
					throw conflict(`channel ${input.channelId} cannot parent another child`);
				}
				let current = access.job(input.channelId, input.answerJobId);
				if (
					!current
					|| current.job.channelId !== input.channelId
					|| current.job.type !== "research-answer"
					|| current.job.targetKey !== target
					|| current.job.targetGeneration !== current.target.generation
					|| current.job.state !== "completed"
					|| !current.artifact
				) {
					throw conflict(
						`background job ${input.answerJobId} is not current completed answer work`,
					);
				}
				let now = timestamp(input.now, "publication time");
				let child = access.createAvailableChannel({
					id: deterministicChannelId(currentParent.repositoryId, found.id),
					repositoryId: currentParent.repositoryId,
					repositoryOwner: currentParent.repositoryOwner,
					repositoryName: currentParent.repositoryName,
					parentChannelId: currentParent.id,
					title: input.title,
					createdBy: found.createdBy,
					now,
					initial: input.initial,
				});
				let saved = this.#saveWorkspace({
					...found,
					publishedChannelId: child.id,
				}, now);
				return { workspace: workspace(saved), channel: child, repeated: false };
			});
		});

	referencesChannel(channelId: string): boolean {
		return [...this.#workspaces.values()].some(value => value.publishedChannelId === channelId);
	}

	readonly list = async (
		channelId: string,
		limit: number,
	): Promise<ResearchWorkspaceSummary[]> => {
		let count = Math.min(100, Math.max(1, limit));
		return [...this.#workspaces.values()]
			.filter(value => value.channelId === channelId)
			.sort((left, right) =>
				right.updatedAt.getTime() - left.updatedAt.getTime() || compareId(left.id, right.id)
			)
			.slice(0, count)
			.map(workspace);
	};

	readonly listRepository = async (
		repositoryId: string,
		limit: number,
		includeArchived = false,
	): Promise<ResearchWorkspaceRepositoryList> => {
		let count = Math.min(RESEARCH_REPOSITORY_WORKSPACE_LIMIT, Math.max(1, limit));
		let orderedChannels = this.#options.channels(repositoryId)
			.filter(channel => includeArchived || !channel.archivedAt)
			.sort((left, right) =>
				right.createdAt.getTime() - left.createdAt.getTime() || compareId(left.id, right.id)
			);
		let workspacesByChannel = new Map<string, ResearchWorkspace[]>();
		for (let saved of this.#workspaces.values()) {
			let values = workspacesByChannel.get(saved.channelId) ?? [];
			values.push(saved);
			workspacesByChannel.set(saved.channelId, values);
		}
		let truncated = orderedChannels.length > RESEARCH_REPOSITORY_CHANNEL_LIMIT;
		let groups: ResearchWorkspaceRepositoryGroup[] = [];
		let workspaceCount = 0;
		for (let channel of orderedChannels.slice(0, RESEARCH_REPOSITORY_CHANNEL_LIMIT)) {
			if (workspaceCount >= count) {
				truncated = true;
				break;
			}
			let workspaces = (workspacesByChannel.get(channel.id) ?? [])
				.sort((left, right) =>
					right.updatedAt.getTime() - left.updatedAt.getTime() || compareId(left.id, right.id)
				)
				.slice(0, RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT);
			if (workspaces.length === RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT) truncated = true;
			let selected = workspaces.slice(0, count - workspaceCount).map(workspace);
			if (selected.length > 0) {
				groups.push({
					channel: {
						id: channel.id,
						repositoryId: channel.repositoryId,
						repositoryOwner: channel.repositoryOwner,
						repositoryName: channel.repositoryName,
						title: channel.title,
						slug: channel.slug,
					},
					workspaces: selected,
				});
			}
			workspaceCount += selected.length;
		}
		if (workspaceCount === count) truncated = true;
		return { channels: groups, truncated };
	};

	readonly get = async (
		channelId: string,
		workspaceId: string,
	): Promise<ResearchWorkspaceDetail | undefined> => {
		let found = this.#workspaces.get(workspaceId);
		if (!found || found.channelId !== channelId) return undefined;
		return {
			workspace: workspace(found),
			turns: (this.#turns.get(found.id) ?? []).map(turn),
			messages: (this.#messages.get(found.id) ?? []).map(message),
		};
	};

	readonly findTurnByJob = async (
		channelId: string,
		jobId: string,
	): Promise<ResearchTurn | undefined> => {
		let linked = this.#linkedJobs.get(jobId);
		let foundTurn = linked && this.#turnIds.get(linked.turnId);
		let foundWorkspace = foundTurn && this.#workspaces.get(foundTurn.workspaceId);
		return foundTurn && foundWorkspace?.channelId === channelId ? turn(foundTurn) : undefined;
	};

	deleteChannel(channelId: string): Promise<void> {
		return this.#mutate(async () => {
			let workspaceIds = new Set<string>();
			for (let [workspaceId, saved] of this.#workspaces) {
				if (saved.channelId === channelId) workspaceIds.add(workspaceId);
			}
			let turnIds = new Set<string>();
			let messageIds = new Set<string>();
			for (let workspaceId of workspaceIds) {
				this.#workspaces.delete(workspaceId);
				for (let saved of this.#turns.get(workspaceId) ?? []) turnIds.add(saved.id);
				for (let saved of this.#messages.get(workspaceId) ?? []) messageIds.add(saved.id);
				this.#turns.delete(workspaceId);
				this.#messages.delete(workspaceId);
				this.#nextOrdinals.delete(workspaceId);
				this.#nextSequences.delete(workspaceId);
			}
			for (let [idempotencyKey, workspaceId] of this.#idempotency) {
				if (workspaceIds.has(workspaceId)) this.#idempotency.delete(idempotencyKey);
			}
			for (let turnId of turnIds) this.#turnIds.delete(turnId);
			for (let [requestKey, turnId] of this.#turnRequests) {
				if (turnIds.has(turnId)) this.#turnRequests.delete(requestKey);
			}
			for (let messageId of messageIds) this.#messageIds.delete(messageId);
			for (let [jobId, saved] of this.#agentMessagesByJob) {
				if (workspaceIds.has(saved.workspaceId)) this.#agentMessagesByJob.delete(jobId);
			}
			for (let [jobId, linked] of this.#linkedJobs) {
				if (turnIds.has(linked.turnId)) this.#linkedJobs.delete(jobId);
			}
		});
	}

	async #mutate<T>(execute: () => Promise<T>): Promise<T> {
		let previous = this.#writeTail;
		let next = Promise.withResolvers<void>();
		this.#writeTail = next.promise;
		await previous;
		try {
			return await execute();
		} finally {
			next.resolve();
		}
	}

	#assertChannel(channelId: string, held: Lease): void {
		this.#options.assertLease(held);
		required(channelId, "channel id");
		if (!this.#options.channelExists(channelId)) {
			throw missing(`channel ${channelId} does not exist`);
		}
	}

	#assertActiveChannel(channelId: string, held: Lease): void {
		this.#assertChannel(channelId, held);
		if (!this.#options.channelActive(channelId)) {
			throw conflict(`channel ${channelId} is archived`);
		}
	}

	#requireUser(userId: string): void {
		if (!this.#options.userExists(userId)) throw missing(`user ${userId} does not exist`);
	}

	#requireWorkspace(channelId: string, workspaceId: string): ResearchWorkspace {
		let found = this.#workspaces.get(workspaceId);
		if (!found || found.channelId !== channelId) {
			throw missing(`research workspace ${workspaceId} does not exist in channel ${channelId}`);
		}
		return found;
	}

	#requireTurn(workspaceId: string, turnId: string): ResearchTurn {
		let found = this.#turnIds.get(turnId);
		if (!found || found.workspaceId !== workspaceId) {
			throw missing(`research turn ${turnId} does not exist in workspace ${workspaceId}`);
		}
		return found;
	}

	#turnForRequest(workspaceId: string, requestId: string): ResearchTurn | undefined {
		let turnId = this.#turnRequests.get(key(workspaceId, requestId));
		return turnId ? this.#turnIds.get(turnId) : undefined;
	}

	#memberMessage(value: ResearchTurn): ResearchMessage {
		let found = (this.#messages.get(value.workspaceId) ?? []).find(item =>
			item.turnId === value.id && item.authorKind === "member"
		);
		if (!found) throw new Error(`research turn ${value.id} has no member message`);
		return found;
	}

	#assertNewTurn(turnId: string, messageId: string): void {
		if (this.#turnIds.has(turnId)) throw conflict(`research turn ${turnId} already exists`);
		if (this.#messageIds.has(messageId)) {
			throw conflict(`research message ${messageId} already exists`);
		}
	}

	#newTurn(input: {
		workspaceId: string;
		id: string;
		kind: ResearchTurn["kind"];
		requestId: string;
		fingerprint: string;
		question: string;
		requestedBy: string;
		now: Date;
	}): ResearchTurn {
		let ordinal = this.#nextOrdinals.get(input.workspaceId) ?? 1;
		let saved: ResearchTurn = {
			id: input.id,
			workspaceId: input.workspaceId,
			ordinal,
			kind: input.kind,
			requestId: input.requestId,
			fingerprint: input.fingerprint,
			question: input.question,
			requestedBy: input.requestedBy,
			evidenceJobId: undefined,
			answerJobId: undefined,
			createdAt: new Date(input.now),
			updatedAt: new Date(input.now),
		};
		this.#turns.get(saved.workspaceId)!.push(saved);
		this.#turnIds.set(saved.id, saved);
		this.#turnRequests.set(key(saved.workspaceId, saved.requestId), saved.id);
		this.#nextOrdinals.set(saved.workspaceId, ordinal + 1);
		return saved;
	}

	#newMemberMessage(
		workspaceId: string,
		messageId: string,
		value: ResearchTurn,
		userHandle: string | undefined,
		now: Date,
	): ResearchMessage {
		let sequence = this.#nextSequences.get(workspaceId) ?? 1;
		let saved: ResearchMessage = {
			id: messageId,
			workspaceId,
			sequence,
			turnId: value.id,
			authorKind: "member",
			userId: value.requestedBy,
			userHandle,
			text: value.question,
			sourceJobId: undefined,
			createdAt: new Date(now),
		};
		this.#messages.get(workspaceId)!.push(saved);
		this.#messageIds.set(saved.id, saved);
		this.#nextSequences.set(workspaceId, sequence + 1);
		return saved;
	}

	#replaceTurn(saved: ResearchTurn): void {
		let values = this.#turns.get(saved.workspaceId)!;
		let index = values.findIndex(value => value.id === saved.id);
		if (index < 0) throw new Error(`research turn ${saved.id} is not indexed`);
		values[index] = saved;
		this.#turnIds.set(saved.id, saved);
	}

	#saveWorkspace(value: ResearchWorkspace, now: Date): ResearchWorkspace {
		let saved: ResearchWorkspace = {
			...value,
			revision: value.revision + 1,
			updatedAt: new Date(Math.max(value.updatedAt.getTime(), now.getTime())),
		};
		this.#workspaces.set(saved.id, saved);
		return saved;
	}
}
