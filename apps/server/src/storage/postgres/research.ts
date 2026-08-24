import { conflict, corrupt, missing } from "../errors";
import { deterministicChannelId } from "../../channels/id";
import {
	RESEARCH_REPOSITORY_CHANNEL_LIMIT,
	RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT,
	RESEARCH_REPOSITORY_WORKSPACE_LIMIT,
} from "../model";

import type { SQL, TransactionSQL } from "bun";
import type {
	AppendResearchAgentMessage,
	AppendResearchAgentMessageResult,
	AppendResearchTurn,
	AppendResearchTurnResult,
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
	ResearchMessage,
	ResearchMessageAuthorKind,
	ResearchTurn,
	ResearchTurnKind,
	ResearchWorkspace,
	ResearchWorkspaceDetail,
	ResearchWorkspaceOrigin,
	ResearchWorkspaceRepositoryChannel,
	ResearchWorkspaceRepositoryGroup,
	ResearchWorkspaceRepositoryList,
	ResearchWorkspaceSummary,
	StartResearchWorkspace,
	StartResearchWorkspaceResult,
} from "../model";
import type { ResearchWorkspaceStore } from "../port";

type Timestamp = Date | string;
type Integer = bigint | number | string;
type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;
type Fence = (transaction: TransactionSQL, lease: Lease) => Promise<void>;
type CreateStoredChannel = (
	transaction: TransactionSQL,
	input: CreateChannel,
) => Promise<ChannelRecord>;

type WorkspaceRow = {
	id: unknown;
	channelId: unknown;
	publishedChannelId: unknown;
	title: unknown;
	proposedQuestion: unknown;
	confirmedQuery: unknown;
	origin: unknown;
	originMessageId: unknown;
	createdBy: unknown;
	confirmedBy: unknown;
	revision: unknown;
	idempotencyKey: unknown;
	fingerprint: unknown;
	createdAt: unknown;
	updatedAt: unknown;
	nextTurnOrdinal?: unknown;
	nextMessageSequence?: unknown;
};

type PublicationParentRow = {
	id: unknown;
	repositoryId: unknown;
	repositoryOwner: unknown;
	repositoryName: unknown;
	parentChannelId: unknown;
	archivedAt: unknown;
};

type PublicationChannelRow = {
	id: unknown;
	repositoryId: unknown;
	repositoryOwner: unknown;
	repositoryName: unknown;
	parentChannelId: unknown;
	title: unknown;
	slug: unknown;
	createdBy: unknown;
	revision: unknown;
	createdAt: unknown;
	updatedAt: unknown;
	archivedAt: unknown;
};

type PublicationJobRow = {
	id: unknown;
	type: unknown;
	targetKey: unknown;
	targetGeneration: unknown;
	currentGeneration: unknown;
	state: unknown;
	artifactJobId: unknown;
};

type RepositoryChannelRow = {
	id: unknown;
	repositoryId: unknown;
	repositoryOwner: unknown;
	repositoryName: unknown;
	title: unknown;
	slug: unknown;
};

type TurnRow = {
	id: unknown;
	workspaceId: unknown;
	ordinal: unknown;
	kind: unknown;
	requestId: unknown;
	fingerprint: unknown;
	question: unknown;
	requestedBy: unknown;
	evidenceJobId: unknown;
	answerJobId: unknown;
	createdAt: unknown;
	updatedAt: unknown;
};

type MessageRow = {
	id: unknown;
	workspaceId: unknown;
	sequence: unknown;
	turnId: unknown;
	authorKind: unknown;
	userId: unknown;
	userHandle: unknown;
	text: unknown;
	sourceJobId: unknown;
	createdAt: unknown;
};

type LinkedJobRow = {
	id: unknown;
	type: unknown;
	targetKey: unknown;
	targetGeneration: unknown;
	currentGeneration: unknown;
};

type LockedWorkspace = {
	workspace: ResearchWorkspace;
	nextTurnOrdinal: number;
	nextMessageSequence: number;
};

const WORKSPACE_COLUMNS = `
	id,
	channel_id AS "channelId",
	published_channel_id AS "publishedChannelId",
	title,
	proposed_question AS "proposedQuestion",
	confirmed_query AS "confirmedQuery",
	origin,
	origin_message_id AS "originMessageId",
	created_by AS "createdBy",
	confirmed_by AS "confirmedBy",
	revision,
	idempotency_key AS "idempotencyKey",
	fingerprint,
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const LOCKED_WORKSPACE_COLUMNS = `
	${WORKSPACE_COLUMNS},
	next_turn_ordinal AS "nextTurnOrdinal",
	next_message_sequence AS "nextMessageSequence"
`;

const TURN_COLUMNS = `
	id,
	workspace_id AS "workspaceId",
	ordinal,
	kind,
	request_id AS "requestId",
	fingerprint,
	question,
	requested_by AS "requestedBy",
	evidence_job_id AS "evidenceJobId",
	answer_job_id AS "answerJobId",
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const QUALIFIED_TURN_COLUMNS = `
	research_turns.id,
	research_turns.workspace_id AS "workspaceId",
	research_turns.ordinal,
	research_turns.kind,
	research_turns.request_id AS "requestId",
	research_turns.fingerprint,
	research_turns.question,
	research_turns.requested_by AS "requestedBy",
	research_turns.evidence_job_id AS "evidenceJobId",
	research_turns.answer_job_id AS "answerJobId",
	research_turns.created_at AS "createdAt",
	research_turns.updated_at AS "updatedAt"
`;

const MESSAGE_COLUMNS = `
	id,
	workspace_id AS "workspaceId",
	sequence,
	turn_id AS "turnId",
	author_kind AS "authorKind",
	user_id AS "userId",
	user_handle AS "userHandle",
	text,
	source_job_id AS "sourceJobId",
	created_at AS "createdAt"
`;

const PUBLICATION_CHANNEL_COLUMNS = `
	channels.id,
	channels.repository_id AS "repositoryId",
	channels.repository_owner AS "repositoryOwner",
	channels.repository_name AS "repositoryName",
	channels.parent_channel_id AS "parentChannelId",
	channels.title,
	(
		SELECT channel_slugs.slug
		FROM channel_slugs
		WHERE channel_slugs.channel_id = channels.id AND channel_slugs.canonical
	) AS slug,
	channels.created_by AS "createdBy",
	channels.revision,
	channels.created_at AS "createdAt",
	channels.updated_at AS "updatedAt",
	channels.archived_at AS "archivedAt"
`;

const ORIGINS = new Set<ResearchWorkspaceOrigin>(["inline", "sidebar", "planner"]);
const TURN_KINDS = new Set<ResearchTurnKind>(["initial", "follow-up", "search-more"]);
const AUTHOR_KINDS = new Set<ResearchMessageAuthorKind>(["member", "agent", "system"]);

function required(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw conflict(`research ${field} must not be empty`);
	return value;
}

function optionalInput(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : required(value, field);
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw corrupt(`storage returned an invalid ${field}`);
	return value;
}

function optionalText(value: unknown, field: string): string | undefined {
	return value === null || value === undefined ? undefined : text(value, field);
}

function date(value: unknown, field: string): Date {
	if (!(value instanceof Date) && typeof value !== "string") {
		throw corrupt(`storage returned an invalid ${field}`);
	}
	let parsed = new Date(value as Timestamp);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function inputDate(value: unknown, field: string): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw conflict(`research ${field} must be a valid timestamp`);
	}
	return new Date(value);
}

function integer(value: unknown, field: string): number {
	if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
		throw corrupt(`storage returned an invalid ${field}`);
	}
	let parsed = typeof value === "number" ? value : Number(value as Integer);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw corrupt(`storage returned an invalid ${field}`);
	}
	return parsed;
}

function workspace(row: WorkspaceRow): ResearchWorkspace {
	let id = text(row.id, "research workspace id");
	let confirmedQuery = optionalText(row.confirmedQuery, "research workspace confirmed query");
	let confirmedBy = optionalText(row.confirmedBy, "research workspace confirming member");
	if ((confirmedQuery === undefined) !== (confirmedBy === undefined)) {
		throw corrupt(`research workspace ${id} has inconsistent confirmation data`);
	}
	if (!ORIGINS.has(row.origin as ResearchWorkspaceOrigin)) {
		throw corrupt(`research workspace ${id} has an invalid origin`);
	}
	let revision = integer(row.revision, "research workspace revision");
	let createdAt = date(row.createdAt, "research workspace creation time");
	let updatedAt = date(row.updatedAt, "research workspace update time");
	if (updatedAt < createdAt) throw corrupt(`research workspace ${id} has invalid timestamps`);
	return {
		id,
		channelId: text(row.channelId, "research workspace channel id"),
		publishedChannelId: optionalText(
			row.publishedChannelId,
			"research workspace published channel id",
		),
		title: text(row.title, "research workspace title"),
		proposedQuestion: text(row.proposedQuestion, "research workspace proposed question"),
		confirmedQuery,
		origin: row.origin as ResearchWorkspaceOrigin,
		originMessageId: optionalText(row.originMessageId, "research workspace origin message id"),
		createdBy: text(row.createdBy, "research workspace creating member"),
		confirmedBy,
		revision,
		idempotencyKey: text(row.idempotencyKey, "research workspace idempotency key"),
		fingerprint: text(row.fingerprint, "research workspace fingerprint"),
		createdAt,
		updatedAt,
	};
}

function publicationChannel(row: PublicationChannelRow): ChannelRecord {
	let archivedAt = row.archivedAt === null
		? undefined
		: date(row.archivedAt, "published channel archive time");
	let parentChannelId = optionalText(row.parentChannelId, "published channel parent id");
	return {
		id: text(row.id, "published channel id"),
		repositoryId: text(row.repositoryId, "published channel repository id"),
		repositoryOwner: text(row.repositoryOwner, "published channel repository owner"),
		repositoryName: text(row.repositoryName, "published channel repository name"),
		...(parentChannelId ? { parentChannelId } : {}),
		title: text(row.title, "published channel title"),
		slug: text(row.slug, "published channel slug"),
		createdBy: text(row.createdBy, "published channel creator"),
		revision: integer(row.revision, "published channel revision"),
		createdAt: date(row.createdAt, "published channel creation time"),
		updatedAt: date(row.updatedAt, "published channel update time"),
		...(archivedAt ? { archivedAt } : {}),
	};
}

function repositoryChannel(row: RepositoryChannelRow): ResearchWorkspaceRepositoryChannel {
	return {
		id: text(row.id, "research repository channel id"),
		repositoryId: text(row.repositoryId, "research repository id"),
		repositoryOwner: text(row.repositoryOwner, "research repository owner"),
		repositoryName: text(row.repositoryName, "research repository name"),
		title: text(row.title, "research repository channel title"),
		slug: text(row.slug, "research repository channel slug"),
	};
}

function lockedWorkspace(row: WorkspaceRow): LockedWorkspace {
	let nextTurnOrdinal = integer(row.nextTurnOrdinal, "research workspace next turn ordinal");
	let nextMessageSequence = integer(
		row.nextMessageSequence,
		"research workspace next message sequence",
	);
	if (nextTurnOrdinal < 1 || nextMessageSequence < 1) {
		throw corrupt(`research workspace ${String(row.id)} has invalid next counters`);
	}
	return { workspace: workspace(row), nextTurnOrdinal, nextMessageSequence };
}

function turn(row: TurnRow): ResearchTurn {
	let id = text(row.id, "research turn id");
	if (!TURN_KINDS.has(row.kind as ResearchTurnKind)) {
		throw corrupt(`research turn ${id} has an invalid kind`);
	}
	let ordinal = integer(row.ordinal, "research turn ordinal");
	if (ordinal < 1) throw corrupt(`research turn ${id} has an invalid ordinal`);
	let evidenceJobId = optionalText(row.evidenceJobId, "research evidence job id");
	let answerJobId = optionalText(row.answerJobId, "research answer job id");
	if (evidenceJobId !== undefined && evidenceJobId === answerJobId) {
		throw corrupt(`research turn ${id} uses one job for two roles`);
	}
	let createdAt = date(row.createdAt, "research turn creation time");
	let updatedAt = date(row.updatedAt, "research turn update time");
	if (updatedAt < createdAt) throw corrupt(`research turn ${id} has invalid timestamps`);
	return {
		id,
		workspaceId: text(row.workspaceId, "research turn workspace id"),
		ordinal,
		kind: row.kind as ResearchTurnKind,
		requestId: text(row.requestId, "research turn request id"),
		fingerprint: text(row.fingerprint, "research turn fingerprint"),
		question: text(row.question, "research turn question"),
		requestedBy: text(row.requestedBy, "research turn requesting member"),
		evidenceJobId,
		answerJobId,
		createdAt,
		updatedAt,
	};
}

function message(row: MessageRow): ResearchMessage {
	let id = text(row.id, "research message id");
	if (!AUTHOR_KINDS.has(row.authorKind as ResearchMessageAuthorKind)) {
		throw corrupt(`research message ${id} has an invalid author kind`);
	}
	let sequence = integer(row.sequence, "research message sequence");
	if (sequence < 1) throw corrupt(`research message ${id} has an invalid sequence`);
	let authorKind = row.authorKind as ResearchMessageAuthorKind;
	let turnId = optionalText(row.turnId, "research message turn id");
	let sourceJobId = optionalText(row.sourceJobId, "research message source job id");
	if (authorKind === "member" && (!turnId || sourceJobId)) {
		throw corrupt(`research member message ${id} has invalid linkage`);
	}
	if (authorKind === "agent" && (!turnId || !sourceJobId)) {
		throw corrupt(`research agent message ${id} has invalid linkage`);
	}
	return {
		id,
		workspaceId: text(row.workspaceId, "research message workspace id"),
		sequence,
		turnId,
		authorKind,
		userId: optionalText(row.userId, "research message user id"),
		userHandle: optionalText(row.userHandle, "research message user handle"),
		text: text(row.text, "research message text"),
		sourceJobId,
		createdAt: date(row.createdAt, "research message creation time"),
	};
}

function same(left: string | undefined, right: string | undefined): boolean {
	return left === right;
}

/** PostgreSQL research workspaces, turns, transcript messages, and job linkage. */
export class PostgresResearchWorkspaceStore implements ResearchWorkspaceStore {
	#sql: SQL;
	#run: Run;
	#fence: Fence;
	#createChannel: CreateStoredChannel;

	constructor(sql: SQL, run: Run, fence: Fence, createChannel: CreateStoredChannel) {
		this.#sql = sql;
		this.#run = run;
		this.#fence = fence;
		this.#createChannel = createChannel;
	}

	readonly create = (input: CreateResearchWorkspace): Promise<CreateResearchWorkspaceResult> =>
		this.#run("create research workspace", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let idempotencyKey = required(input.idempotencyKey, "workspace idempotency key");
				let fingerprint = required(input.fingerprint, "workspace fingerprint");
				let archived = await this.#lockChannelArchiveState(transaction, channelId);
				let [existing] = await transaction<WorkspaceRow[]>`
					SELECT ${transaction.unsafe(WORKSPACE_COLUMNS)}
					FROM research_workspaces
					WHERE channel_id = ${channelId} AND idempotency_key = ${idempotencyKey}
					FOR UPDATE
				`;
				if (existing) {
					let repeated = workspace(existing);
					if (repeated.fingerprint !== fingerprint) {
						throw conflict(`research workspace idempotency key ${idempotencyKey} was reused`);
					}
					return { workspace: repeated, repeated: true };
				}
				if (archived) throw conflict(`channel ${channelId} is archived`);

				let id = required(input.id, "workspace id");
				let title = required(input.title, "workspace title");
				let proposedQuestion = required(input.proposedQuestion, "workspace proposed question");
				let createdBy = required(input.createdBy, "creating member id");
				let originMessageId = optionalInput(
					input.originMessageId,
					"workspace origin message id",
				);
				if (!ORIGINS.has(input.origin)) throw conflict("research workspace origin is invalid");
				let now = inputDate(input.now, "workspace creation time");
				let [saved] = await transaction<WorkspaceRow[]>`
					INSERT INTO research_workspaces (
						id, channel_id, title, proposed_question, origin, origin_message_id,
						created_by, revision, next_turn_ordinal, next_message_sequence,
						idempotency_key, fingerprint, created_at, updated_at
					) VALUES (
						${id}, ${channelId}, ${title}, ${proposedQuestion}, ${input.origin},
						${originMessageId ?? null}, ${createdBy}, 0, 1, 1,
						${idempotencyKey}, ${fingerprint}, ${now}, ${now}
					)
					RETURNING ${transaction.unsafe(WORKSPACE_COLUMNS)}
				`;
				if (!saved) throw corrupt("creating a research workspace returned no record");
				return { workspace: workspace(saved), repeated: false };
			}));

	readonly start = (
		input: StartResearchWorkspace,
	): Promise<StartResearchWorkspaceResult> =>
		this.#run("start research workspace", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let idempotencyKey = required(input.idempotencyKey, "workspace idempotency key");
				let fingerprint = required(input.fingerprint, "workspace fingerprint");
				let archived = await this.#lockChannelArchiveState(transaction, channelId);
				let [existing] = await transaction<WorkspaceRow[]>`
					SELECT ${transaction.unsafe(WORKSPACE_COLUMNS)}
					FROM research_workspaces
					WHERE channel_id = ${channelId} AND idempotency_key = ${idempotencyKey}
					FOR UPDATE
				`;
				if (existing) {
					let repeated = workspace(existing);
					let [turnRow] = await transaction<TurnRow[]>`
						SELECT ${transaction.unsafe(TURN_COLUMNS)}
						FROM research_turns
						WHERE workspace_id = ${repeated.id} AND ordinal = 1
					`;
					let repeatedTurn = turnRow ? turn(turnRow) : undefined;
					if (
						repeated.fingerprint !== fingerprint
						|| repeated.origin !== "inline"
						|| !repeatedTurn
						|| repeatedTurn.kind !== "initial"
					) {
						throw conflict(
							`research workspace idempotency key ${idempotencyKey} was reused`,
						);
					}
					return {
						workspace: repeated,
						turn: repeatedTurn,
						message: await this.#memberMessage(transaction, repeatedTurn),
						repeated: true,
					};
				}
				if (archived) throw conflict(`channel ${channelId} is archived`);
				let workspaceId = required(input.id, "workspace id");
				let title = required(input.title, "workspace title");
				let question = required(input.question, "workspace question");
				let createdBy = required(input.createdBy, "creating member id");
				let createdByHandle = optionalInput(
					input.createdByHandle,
					"creating member handle",
				);
				let requestId = required(input.requestId, "request id");
				let now = inputDate(input.now, "workspace start time");
				let [savedWorkspaceRow] = await transaction<WorkspaceRow[]>`
					INSERT INTO research_workspaces (
						id, channel_id, title, proposed_question, confirmed_query, origin,
						created_by, confirmed_by, revision, next_turn_ordinal,
						next_message_sequence, idempotency_key, fingerprint, created_at, updated_at
					) VALUES (
						${workspaceId}, ${channelId}, ${title}, ${question}, ${question}, 'inline',
						${createdBy}, ${createdBy}, 0, 2, 2, ${idempotencyKey}, ${fingerprint},
						${now}, ${now}
					)
					RETURNING ${transaction.unsafe(WORKSPACE_COLUMNS)}
				`;
				if (!savedWorkspaceRow) {
					throw corrupt("starting a research workspace returned no record");
				}
				let savedTurn = await this.#insertTurn(transaction, {
					id: required(input.turnId, "turn id"),
					workspaceId,
					ordinal: 1,
					kind: "initial",
					requestId,
					fingerprint,
					question,
					requestedBy: createdBy,
					now,
				});
				let savedMessage = await this.#insertMemberMessage(
					transaction,
					workspaceId,
					1,
					required(input.messageId, "message id"),
					savedTurn,
					createdByHandle,
					now,
				);
				return {
					workspace: workspace(savedWorkspaceRow),
					turn: savedTurn,
					message: savedMessage,
					repeated: false,
				};
			}));

	readonly confirm = (
		input: ConfirmResearchWorkspace,
	): Promise<ConfirmResearchWorkspaceResult> =>
		this.#run("confirm research workspace", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let workspaceId = required(input.workspaceId, "workspace id");
				let requestId = required(input.requestId, "confirmation request id");
				let fingerprint = required(input.fingerprint, "confirmation fingerprint");
				let confirmedQuery = required(input.confirmedQuery, "confirmed query");
				let confirmedBy = required(input.confirmedBy, "confirming member id");
				let confirmedByHandle = optionalInput(
					input.confirmedByHandle,
					"confirming member handle",
				);
				let archived = await this.#lockChannelArchiveState(transaction, channelId);
				let locked = await this.#lockWorkspace(transaction, channelId, workspaceId);
				let repeated = await this.#turnForRequest(transaction, workspaceId, requestId);
				if (repeated) {
					let repeatedMessage = await this.#memberMessage(transaction, repeated);
					if (
						repeated.kind !== "initial"
						|| repeated.fingerprint !== fingerprint
						|| repeated.question !== confirmedQuery
						|| repeated.requestedBy !== confirmedBy
						|| !same(repeatedMessage.userHandle, confirmedByHandle)
					) throw conflict(`research request ${requestId} was reused with another payload`);
					return {
						workspace: locked.workspace,
						turn: repeated,
						message: repeatedMessage,
						repeated: true,
					};
				}
				if (archived) throw conflict(`channel ${channelId} is archived`);
				if (locked.workspace.confirmedQuery !== undefined) {
					throw conflict(`research workspace ${workspaceId} is already confirmed`);
				}
				let turnId = required(input.turnId, "turn id");
				let messageId = required(input.messageId, "message id");
				let now = inputDate(input.now, "confirmation time");
				let savedTurn = await this.#insertTurn(transaction, {
					id: turnId,
					workspaceId,
					ordinal: locked.nextTurnOrdinal,
					kind: "initial",
					requestId,
					fingerprint,
					question: confirmedQuery,
					requestedBy: confirmedBy,
					now,
				});
				let savedMessage = await this.#insertMemberMessage(
					transaction,
					workspaceId,
					locked.nextMessageSequence,
					messageId,
					savedTurn,
					confirmedByHandle,
					now,
				);
				let [savedWorkspace] = await transaction<WorkspaceRow[]>`
					UPDATE research_workspaces SET
						confirmed_query = ${confirmedQuery},
						confirmed_by = ${confirmedBy},
						revision = revision + 1,
						next_turn_ordinal = next_turn_ordinal + 1,
						next_message_sequence = next_message_sequence + 1,
						updated_at = GREATEST(updated_at, ${now})
					WHERE id = ${workspaceId}
					RETURNING ${transaction.unsafe(WORKSPACE_COLUMNS)}
				`;
				if (!savedWorkspace) throw corrupt("confirming a research workspace returned no record");
				return {
					workspace: workspace(savedWorkspace),
					turn: savedTurn,
					message: savedMessage,
					repeated: false,
				};
			}));

	readonly appendTurn = (input: AppendResearchTurn): Promise<AppendResearchTurnResult> =>
		this.#run("append research turn", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let workspaceId = required(input.workspaceId, "workspace id");
				let requestId = required(input.requestId, "turn request id");
				let fingerprint = required(input.fingerprint, "turn fingerprint");
				let question = required(input.question, "turn question");
				let requestedBy = required(input.requestedBy, "requesting member id");
				let requestedByHandle = optionalInput(
					input.requestedByHandle,
					"requesting member handle",
				);
				if (input.kind !== "follow-up" && input.kind !== "search-more") {
					throw conflict("research appended turn kind is invalid");
				}
				let archived = await this.#lockChannelArchiveState(transaction, channelId);
				let locked = await this.#lockWorkspace(transaction, channelId, workspaceId);
				let repeated = await this.#turnForRequest(transaction, workspaceId, requestId);
				if (repeated) {
					let repeatedMessage = await this.#memberMessage(transaction, repeated);
					if (
						repeated.kind !== input.kind
						|| repeated.fingerprint !== fingerprint
						|| repeated.question !== question
						|| repeated.requestedBy !== requestedBy
						|| !same(repeatedMessage.userHandle, requestedByHandle)
					) throw conflict(`research request ${requestId} was reused with another payload`);
					return {
						workspace: locked.workspace,
						turn: repeated,
						message: repeatedMessage,
						repeated: true,
					};
				}
				if (archived) throw conflict(`channel ${channelId} is archived`);
				if (locked.workspace.confirmedQuery === undefined) {
					throw conflict(`research workspace ${workspaceId} is not confirmed`);
				}
				let now = inputDate(input.now, "turn creation time");
				let savedTurn = await this.#insertTurn(transaction, {
					id: required(input.turnId, "turn id"),
					workspaceId,
					ordinal: locked.nextTurnOrdinal,
					kind: input.kind,
					requestId,
					fingerprint,
					question,
					requestedBy,
					now,
				});
				let savedMessage = await this.#insertMemberMessage(
					transaction,
					workspaceId,
					locked.nextMessageSequence,
					required(input.messageId, "message id"),
					savedTurn,
					requestedByHandle,
					now,
				);
				let savedWorkspace = await this.#bumpWorkspace(transaction, workspaceId, now, 1, 1);
				return {
					workspace: savedWorkspace,
					turn: savedTurn,
					message: savedMessage,
					repeated: false,
				};
			}));

	readonly linkJob = (input: LinkResearchTurnJob): Promise<LinkResearchTurnJobResult> =>
		this.#run("link research job", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let workspaceId = required(input.workspaceId, "workspace id");
				let turnId = required(input.turnId, "turn id");
				let jobId = required(input.jobId, "linked job id");
				if (input.role !== "evidence" && input.role !== "answer") {
					throw conflict("research job role is invalid");
				}
				let locked = await this.#lockWorkspace(transaction, channelId, workspaceId);
				let foundTurn = await this.#lockTurn(transaction, workspaceId, turnId);
				let [job] = await transaction<LinkedJobRow[]>`
					SELECT jobs.id, jobs.type, jobs.target_key AS "targetKey",
						jobs.target_generation AS "targetGeneration",
						targets.generation AS "currentGeneration"
					FROM background_jobs AS jobs
					JOIN background_job_targets AS targets
						ON targets.channel_id = jobs.channel_id
						AND targets.target_key = jobs.target_key
					WHERE jobs.id = ${jobId} AND jobs.channel_id = ${channelId}
				`;
				if (!job) {
					throw missing(`background job ${jobId} does not exist in channel ${channelId}`);
				}
				let type = input.role === "evidence" ? "research-evidence" : "research-answer";
				let target = `${type}:workspace:${workspaceId}:turn:${turnId}:${input.role}`;
				if (
					text(job.type, "research linked job type") !== type
					|| text(job.targetKey, "research linked job target") !== target
					|| integer(job.targetGeneration, "research linked job generation")
						!== integer(job.currentGeneration, "research linked current generation")
				) throw conflict(`background job ${jobId} is not current ${input.role} work for the turn`);
				let current = input.role === "evidence"
					? foundTurn.evidenceJobId
					: foundTurn.answerJobId;
				if (current !== undefined) {
					if (current !== jobId) {
						throw conflict(`research turn ${turnId} already has an ${input.role} job`);
					}
					return { workspace: locked.workspace, turn: foundTurn, repeated: true };
				}
				let [linked] = await transaction<{ id: string }[]>`
					SELECT id FROM research_turns
					WHERE evidence_job_id = ${jobId} OR answer_job_id = ${jobId}
					LIMIT 1
				`;
				if (linked) throw conflict(`background job ${jobId} is already linked to a research turn`);
				let now = inputDate(input.now, "job link time");
				let rows = input.role === "evidence"
					? await transaction<TurnRow[]>`
						UPDATE research_turns SET
							evidence_job_id = ${jobId},
							updated_at = GREATEST(updated_at, ${now})
						WHERE id = ${turnId} AND workspace_id = ${workspaceId}
						RETURNING ${transaction.unsafe(TURN_COLUMNS)}
					`
					: await transaction<TurnRow[]>`
						UPDATE research_turns SET
							answer_job_id = ${jobId},
							updated_at = GREATEST(updated_at, ${now})
						WHERE id = ${turnId} AND workspace_id = ${workspaceId}
						RETURNING ${transaction.unsafe(TURN_COLUMNS)}
					`;
				let savedTurnRow = rows[0];
				if (!savedTurnRow) throw corrupt("linking a research job returned no turn");
				let savedWorkspace = await this.#bumpWorkspace(transaction, workspaceId, now, 0, 0);
				return {
					workspace: savedWorkspace,
					turn: turn(savedTurnRow),
					repeated: false,
				};
			}));

	readonly appendAgentMessage = (
		input: AppendResearchAgentMessage,
	): Promise<AppendResearchAgentMessageResult> =>
		this.#run("append research agent message", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let workspaceId = required(input.workspaceId, "workspace id");
				let id = required(input.id, "message id");
				let turnId = required(input.turnId, "message turn id");
				let sourceJobId = required(input.sourceJobId, "message source job id");
				let body = required(input.text, "message text");
				let userId = optionalInput(input.userId, "message user id");
				let userHandle = optionalInput(input.userHandle, "message user handle");
				let locked = await this.#lockWorkspace(transaction, channelId, workspaceId);
				let [existing] = await transaction<MessageRow[]>`
					SELECT ${transaction.unsafe(MESSAGE_COLUMNS)}
					FROM research_messages
					WHERE id = ${id} OR (author_kind = 'agent' AND source_job_id = ${sourceJobId})
					ORDER BY CASE WHEN id = ${id} THEN 0 ELSE 1 END
					LIMIT 1
				`;
				if (existing) {
					let repeated = message(existing);
					if (
						repeated.workspaceId !== workspaceId
						|| repeated.authorKind !== "agent"
						|| repeated.turnId !== turnId
						|| repeated.sourceJobId !== sourceJobId
						|| repeated.userId !== userId
						|| repeated.userHandle !== userHandle
						|| repeated.text !== body
					) throw conflict(`research message ${id} was reused with another payload`);
					return { workspace: locked.workspace, message: repeated, repeated: true };
				}
				let foundTurn = await this.#lockTurn(transaction, workspaceId, turnId);
				if (foundTurn.answerJobId !== sourceJobId) {
					throw conflict(`research turn ${turnId} is not linked to answer job ${sourceJobId}`);
				}
				let [job] = await transaction<{ id: string }[]>`
					SELECT id FROM background_jobs
					WHERE id = ${sourceJobId} AND channel_id = ${channelId}
				`;
				if (!job) {
					throw missing(`background job ${sourceJobId} does not exist in channel ${channelId}`);
				}
				let now = inputDate(input.now, "message creation time");
				let [saved] = await transaction<MessageRow[]>`
					INSERT INTO research_messages (
						id, workspace_id, sequence, turn_id, author_kind, user_id,
						user_handle, text, source_job_id, created_at
					) VALUES (
						${id}, ${workspaceId}, ${locked.nextMessageSequence}, ${turnId}, 'agent',
						${userId ?? null}, ${userHandle ?? null}, ${body}, ${sourceJobId}, ${now}
					)
					RETURNING ${transaction.unsafe(MESSAGE_COLUMNS)}
				`;
				if (!saved) throw corrupt("appending a research agent message returned no record");
				let savedWorkspace = await this.#bumpWorkspace(transaction, workspaceId, now, 0, 1);
				return {
					workspace: savedWorkspace,
					message: message(saved),
					repeated: false,
				};
			}));

	readonly publishInitialReport = (
		input: PublishInitialResearchReport,
	): Promise<PublishInitialResearchReportResult> =>
		this.#run("publish initial research report", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let channelId = required(input.channelId, "channel id");
				let workspaceId = required(input.workspaceId, "workspace id");
				let answerJobId = required(input.answerJobId, "publication answer job id");
				let title = required(input.title, "publication title");
				let now = inputDate(input.now, "publication time");
				let [parentRow] = await transaction<PublicationParentRow[]>`
					SELECT
						id,
						repository_id AS "repositoryId",
						repository_owner AS "repositoryOwner",
						repository_name AS "repositoryName",
						parent_channel_id AS "parentChannelId",
						archived_at AS "archivedAt"
					FROM channels
					WHERE id = ${channelId}
					FOR UPDATE
				`;
				if (!parentRow) throw missing(`channel ${channelId} does not exist`);
				let parentId = text(parentRow.id, "publication parent channel id");
				let repositoryId = text(parentRow.repositoryId, "publication repository id");
				let locked = await this.#lockWorkspace(transaction, channelId, workspaceId);
				let [initialTurnRow] = await transaction<TurnRow[]>`
					SELECT ${transaction.unsafe(TURN_COLUMNS)}
					FROM research_turns
					WHERE workspace_id = ${workspaceId} AND ordinal = 1
					FOR UPDATE
				`;
				let initialTurn = initialTurnRow ? turn(initialTurnRow) : undefined;
				if (
					!initialTurn
					|| initialTurn.kind !== "initial"
					|| initialTurn.answerJobId !== answerJobId
				) {
					throw conflict(
						`research workspace ${workspaceId} is not linked to initial answer job ${answerJobId}`,
					);
				}
				if (locked.workspace.publishedChannelId) {
					let [publishedRow] = await transaction<PublicationChannelRow[]>`
						SELECT ${transaction.unsafe(PUBLICATION_CHANNEL_COLUMNS)}
						FROM channels
						WHERE channels.id = ${locked.workspace.publishedChannelId}
					`;
					if (!publishedRow) {
						throw corrupt(
							`research workspace ${workspaceId} has a missing published channel`,
						);
					}
					return {
						workspace: locked.workspace,
						channel: publicationChannel(publishedRow),
						repeated: true,
					};
				}
				if (parentRow.archivedAt !== null) throw conflict(`channel ${channelId} is archived`);
				if (parentRow.parentChannelId !== null) {
					throw conflict(`channel ${channelId} cannot parent another child`);
				}
				let [answer] = await transaction<PublicationJobRow[]>`
					SELECT
						jobs.id,
						jobs.type,
						jobs.target_key AS "targetKey",
						jobs.target_generation AS "targetGeneration",
						targets.generation AS "currentGeneration",
						jobs.state,
						artifacts.job_id AS "artifactJobId"
					FROM background_jobs AS jobs
					JOIN background_job_targets AS targets
						ON targets.channel_id = jobs.channel_id
						AND targets.target_key = jobs.target_key
					LEFT JOIN background_job_artifacts AS artifacts ON artifacts.job_id = jobs.id
					WHERE jobs.id = ${answerJobId} AND jobs.channel_id = ${channelId}
					FOR UPDATE OF jobs
				`;
				let target = `research-answer:workspace:${workspaceId}:turn:${initialTurn.id}:answer`;
				if (
					!answer
					|| text(answer.type, "publication answer job type") !== "research-answer"
					|| text(answer.targetKey, "publication answer job target") !== target
					|| integer(answer.targetGeneration, "publication answer job generation")
						!== integer(answer.currentGeneration, "publication current job generation")
					|| text(answer.state, "publication answer job state") !== "completed"
					|| optionalText(answer.artifactJobId, "publication answer artifact") !== answerJobId
				) {
					throw conflict(`background job ${answerJobId} is not current completed answer work`);
				}

				let childId = deterministicChannelId(repositoryId, workspaceId);
				let savedChannel = await this.#createChannel(
					transaction,
					{
						id: childId,
						repositoryId,
						repositoryOwner: text(
							parentRow.repositoryOwner,
							"publication repository owner",
						),
						repositoryName: text(
							parentRow.repositoryName,
							"publication repository name",
						),
						parentChannelId: parentId,
						title,
						createdBy: locked.workspace.createdBy,
						now,
						initial: input.initial,
					},
				);
				let [savedWorkspaceRow] = await transaction<WorkspaceRow[]>`
					UPDATE research_workspaces SET
						published_channel_id = ${childId},
						revision = revision + 1,
						updated_at = GREATEST(updated_at, ${now})
					WHERE id = ${workspaceId} AND channel_id = ${channelId}
					RETURNING ${transaction.unsafe(WORKSPACE_COLUMNS)}
				`;
				if (!savedWorkspaceRow) {
					throw corrupt("publishing an initial research report returned no workspace");
				}
				return {
					workspace: workspace(savedWorkspaceRow),
					channel: savedChannel,
					repeated: false,
				};
			}));

	readonly list = (
		channelId: string,
		limit: number,
	): Promise<ResearchWorkspaceSummary[]> =>
		this.#run("list research workspaces", async () => {
			let count = Math.min(100, Math.max(1, limit));
			let rows = await this.#sql<WorkspaceRow[]>`
				SELECT ${this.#sql.unsafe(WORKSPACE_COLUMNS)}
				FROM research_workspaces
				WHERE channel_id = ${channelId}
				ORDER BY updated_at DESC, id ASC
				LIMIT ${count}
			`;
			return rows.map(workspace);
		});

	readonly listRepository = (
		repositoryId: string,
		limit: number,
		includeArchived = false,
	): Promise<ResearchWorkspaceRepositoryList> =>
		this.#run(
			"list repository research workspaces",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let count = Math.min(RESEARCH_REPOSITORY_WORKSPACE_LIMIT, Math.max(1, limit));
					let channelRows = await transaction<RepositoryChannelRow[]>`
						SELECT
							channels.id,
							channels.repository_id AS "repositoryId",
							channels.repository_owner AS "repositoryOwner",
							channels.repository_name AS "repositoryName",
							channels.title,
							(
								SELECT channel_slugs.slug
								FROM channel_slugs
								WHERE channel_slugs.channel_id = channels.id AND channel_slugs.canonical
							) AS slug
						FROM channels
						WHERE channels.repository_id = ${repositoryId}
							AND (${includeArchived} OR channels.archived_at IS NULL)
						ORDER BY channels.created_at DESC, channels.id ASC
						LIMIT ${RESEARCH_REPOSITORY_CHANNEL_LIMIT + 1}
					`;
					let channels = channelRows.slice(0, RESEARCH_REPOSITORY_CHANNEL_LIMIT)
						.map(repositoryChannel);
					let channelsById = new Map(channels.map(channel => [channel.id, channel]));
					let workspaceRows = await transaction<WorkspaceRow[]>`
						WITH repository_channels AS MATERIALIZED (
							SELECT channels.id, channels.created_at
							FROM channels
							WHERE channels.repository_id = ${repositoryId}
								AND (${includeArchived} OR channels.archived_at IS NULL)
							ORDER BY channels.created_at DESC, channels.id ASC
							LIMIT ${RESEARCH_REPOSITORY_CHANNEL_LIMIT}
						)
						SELECT workspaces.*
						FROM repository_channels
						CROSS JOIN LATERAL (
							SELECT ${transaction.unsafe(WORKSPACE_COLUMNS)}
							FROM research_workspaces
							WHERE research_workspaces.channel_id = repository_channels.id
							ORDER BY research_workspaces.updated_at DESC, research_workspaces.id ASC
							LIMIT ${RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT}
						) AS workspaces
						ORDER BY
							repository_channels.created_at DESC,
							repository_channels.id ASC,
							workspaces."updatedAt" DESC,
							workspaces.id ASC
						LIMIT ${count}
					`;
					let groups: ResearchWorkspaceRepositoryGroup[] = [];
					let groupsByChannel = new Map<string, ResearchWorkspaceRepositoryGroup>();
					for (let row of workspaceRows) {
						let saved = workspace(row);
						let channel = channelsById.get(saved.channelId);
						if (!channel) {
							throw corrupt(`research workspace ${saved.id} has an invalid repository channel`);
						}
						let group = groupsByChannel.get(channel.id);
						if (!group) {
							group = { channel, workspaces: [] };
							groupsByChannel.set(channel.id, group);
							groups.push(group);
						}
						group.workspaces.push(saved);
					}
					let truncated = channelRows.length > RESEARCH_REPOSITORY_CHANNEL_LIMIT
						|| workspaceRows.length === count
						|| groups.some(group =>
							group.workspaces.length === RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT
						);
					return { channels: groups, truncated };
				}),
		);

	readonly get = (
		channelId: string,
		workspaceId: string,
	): Promise<ResearchWorkspaceDetail | undefined> =>
		this.#run(
			"read research workspace",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let [workspaceRow] = await transaction<WorkspaceRow[]>`
						SELECT ${transaction.unsafe(LOCKED_WORKSPACE_COLUMNS)}
						FROM research_workspaces
						WHERE id = ${workspaceId} AND channel_id = ${channelId}
					`;
					if (!workspaceRow) return undefined;
					let locked = lockedWorkspace(workspaceRow);
					let savedWorkspace = locked.workspace;
					let turnRows = await transaction<TurnRow[]>`
						SELECT ${transaction.unsafe(TURN_COLUMNS)}
						FROM research_turns
						WHERE workspace_id = ${workspaceId}
						ORDER BY ordinal ASC
						LIMIT 102
					`;
					let messageRows = await transaction<MessageRow[]>`
						SELECT ${transaction.unsafe(MESSAGE_COLUMNS)}
						FROM research_messages
						WHERE workspace_id = ${workspaceId}
						ORDER BY sequence ASC
						LIMIT 202
					`;
					await this.#validateJobChannels(transaction, savedWorkspace);
					let detail = {
						workspace: savedWorkspace,
						turns: turnRows.map(turn),
						messages: messageRows.map(message),
					};
					this.#validateDetail(detail, locked);
					return detail;
				}),
		);

	readonly findTurnByJob = (channelId: string, jobId: string): Promise<ResearchTurn | undefined> =>
		this.#run("find research turn by job", async () => {
			let rows = await this.#sql<
				(TurnRow & { workspaceChannelId: unknown; jobChannelId: unknown })[]
			>`
				SELECT ${this.#sql.unsafe(QUALIFIED_TURN_COLUMNS)},
					research_workspaces.channel_id AS "workspaceChannelId",
					background_jobs.channel_id AS "jobChannelId"
				FROM research_turns
				JOIN research_workspaces ON research_workspaces.id = research_turns.workspace_id
				JOIN background_jobs ON background_jobs.id = ${jobId}
				WHERE research_workspaces.channel_id = ${channelId}
					AND (research_turns.evidence_job_id = ${jobId} OR research_turns.answer_job_id = ${jobId})
				LIMIT 2
			`;
			if (rows.length > 1) {
				throw corrupt(`background job ${jobId} links to multiple research turns`);
			}
			let row = rows[0];
			if (!row) return undefined;
			let workspaceChannelId = text(row.workspaceChannelId, "research workspace channel id");
			let jobChannelId = text(row.jobChannelId, "research linked job channel id");
			if (workspaceChannelId !== jobChannelId || workspaceChannelId !== channelId) {
				throw corrupt(`background job ${jobId} is linked across research channels`);
			}
			return turn(row);
		});

	async #lockWorkspace(
		transaction: TransactionSQL,
		channelId: string,
		workspaceId: string,
	): Promise<LockedWorkspace> {
		let [row] = await transaction<WorkspaceRow[]>`
			SELECT ${transaction.unsafe(LOCKED_WORKSPACE_COLUMNS)}
			FROM research_workspaces
			WHERE id = ${workspaceId} AND channel_id = ${channelId}
			FOR UPDATE
		`;
		if (!row) {
			throw missing(`research workspace ${workspaceId} does not exist in channel ${channelId}`);
		}
		return lockedWorkspace(row);
	}

	async #lockChannelArchiveState(
		transaction: TransactionSQL,
		channelId: string,
	): Promise<boolean> {
		let [row] = await transaction<{ archivedAt: Timestamp | null }[]>`
			SELECT archived_at AS "archivedAt"
			FROM channels
			WHERE id = ${channelId}
			FOR UPDATE
		`;
		if (!row) throw missing(`channel ${channelId} does not exist`);
		return row.archivedAt !== null;
	}

	async #lockTurn(
		transaction: TransactionSQL,
		workspaceId: string,
		turnId: string,
	): Promise<ResearchTurn> {
		let [row] = await transaction<TurnRow[]>`
			SELECT ${transaction.unsafe(TURN_COLUMNS)}
			FROM research_turns
			WHERE id = ${turnId} AND workspace_id = ${workspaceId}
			FOR UPDATE
		`;
		if (!row) throw missing(`research turn ${turnId} does not exist in workspace ${workspaceId}`);
		return turn(row);
	}

	async #turnForRequest(
		transaction: TransactionSQL,
		workspaceId: string,
		requestId: string,
	): Promise<ResearchTurn | undefined> {
		let [row] = await transaction<TurnRow[]>`
			SELECT ${transaction.unsafe(TURN_COLUMNS)}
			FROM research_turns
			WHERE workspace_id = ${workspaceId} AND request_id = ${requestId}
		`;
		return row ? turn(row) : undefined;
	}

	async #memberMessage(
		transaction: TransactionSQL,
		value: ResearchTurn,
	): Promise<ResearchMessage> {
		let rows = await transaction<MessageRow[]>`
			SELECT ${transaction.unsafe(MESSAGE_COLUMNS)}
			FROM research_messages
			WHERE workspace_id = ${value.workspaceId}
				AND turn_id = ${value.id}
				AND author_kind = 'member'
			LIMIT 2
		`;
		if (rows.length !== 1) throw corrupt(`research turn ${value.id} has invalid member messages`);
		return message(rows[0]!);
	}

	async #insertTurn(
		transaction: TransactionSQL,
		input: {
			id: string;
			workspaceId: string;
			ordinal: number;
			kind: ResearchTurnKind;
			requestId: string;
			fingerprint: string;
			question: string;
			requestedBy: string;
			now: Date;
		},
	): Promise<ResearchTurn> {
		let [saved] = await transaction<TurnRow[]>`
			INSERT INTO research_turns (
				id, workspace_id, ordinal, kind, request_id, fingerprint,
				question, requested_by, created_at, updated_at
			) VALUES (
				${input.id}, ${input.workspaceId}, ${input.ordinal}, ${input.kind},
				${input.requestId}, ${input.fingerprint}, ${input.question},
				${input.requestedBy}, ${input.now}, ${input.now}
			)
			RETURNING ${transaction.unsafe(TURN_COLUMNS)}
		`;
		if (!saved) throw corrupt("creating a research turn returned no record");
		return turn(saved);
	}

	async #insertMemberMessage(
		transaction: TransactionSQL,
		workspaceId: string,
		sequence: number,
		id: string,
		value: ResearchTurn,
		userHandle: string | undefined,
		now: Date,
	): Promise<ResearchMessage> {
		let [saved] = await transaction<MessageRow[]>`
			INSERT INTO research_messages (
				id, workspace_id, sequence, turn_id, author_kind, user_id,
				user_handle, text, created_at
			) VALUES (
				${id}, ${workspaceId}, ${sequence}, ${value.id}, 'member', ${value.requestedBy},
				${userHandle ?? null}, ${value.question}, ${now}
			)
			RETURNING ${transaction.unsafe(MESSAGE_COLUMNS)}
		`;
		if (!saved) throw corrupt("creating a research member message returned no record");
		return message(saved);
	}

	async #bumpWorkspace(
		transaction: TransactionSQL,
		workspaceId: string,
		now: Date,
		turns: number,
		messages: number,
	): Promise<ResearchWorkspace> {
		let [saved] = await transaction<WorkspaceRow[]>`
			UPDATE research_workspaces SET
				revision = revision + 1,
				next_turn_ordinal = next_turn_ordinal + ${turns},
				next_message_sequence = next_message_sequence + ${messages},
				updated_at = GREATEST(updated_at, ${now})
			WHERE id = ${workspaceId}
			RETURNING ${transaction.unsafe(WORKSPACE_COLUMNS)}
		`;
		if (!saved) throw corrupt("advancing a research workspace returned no record");
		return workspace(saved);
	}

	async #validateJobChannels(
		transaction: TransactionSQL,
		value: ResearchWorkspace,
	): Promise<void> {
		let [invalid] = await transaction<{ count: Integer }[]>`
			SELECT count(*) AS count
			FROM (
				SELECT research_turns.id
				FROM research_turns
				LEFT JOIN background_jobs AS evidence
					ON evidence.id = research_turns.evidence_job_id
				LEFT JOIN background_jobs AS answer
					ON answer.id = research_turns.answer_job_id
				WHERE research_turns.workspace_id = ${value.id}
					AND (
						(research_turns.evidence_job_id IS NOT NULL AND evidence.channel_id <> ${value.channelId})
						OR
						(research_turns.answer_job_id IS NOT NULL AND answer.channel_id <> ${value.channelId})
					)
				UNION ALL
				SELECT research_messages.id
				FROM research_messages
				JOIN background_jobs ON background_jobs.id = research_messages.source_job_id
				WHERE research_messages.workspace_id = ${value.id}
					AND background_jobs.channel_id <> ${value.channelId}
			) AS invalid_links
		`;
		if (!invalid || integer(invalid.count, "invalid research job link count") !== 0) {
			throw corrupt(`research workspace ${value.id} links jobs from another channel`);
		}
	}

	#validateDetail(value: ResearchWorkspaceDetail, locked: LockedWorkspace): void {
		let { workspace: savedWorkspace, turns, messages } = value;
		if (
			locked.nextTurnOrdinal !== turns.length + 1
			|| locked.nextMessageSequence !== messages.length + 1
		) throw corrupt(`research workspace ${savedWorkspace.id} has inconsistent next counters`);
		if (savedWorkspace.confirmedQuery === undefined) {
			if (turns.length > 0 || messages.length > 0) {
				throw corrupt(`unconfirmed research workspace ${savedWorkspace.id} has a transcript`);
			}
			return;
		}
		if (turns.length === 0 || turns[0]!.kind !== "initial") {
			throw corrupt(`confirmed research workspace ${savedWorkspace.id} has no initial turn`);
		}
		if (
			turns[0]!.question !== savedWorkspace.confirmedQuery
			|| turns[0]!.requestedBy !== savedWorkspace.confirmedBy
		) throw corrupt(`research workspace ${savedWorkspace.id} has an inconsistent initial turn`);
		let byId = new Map<string, ResearchTurn>();
		for (let [index, savedTurn] of turns.entries()) {
			if (savedTurn.workspaceId !== savedWorkspace.id || savedTurn.ordinal !== index + 1) {
				throw corrupt(`research workspace ${savedWorkspace.id} has invalid turn ordering`);
			}
			if (index > 0 && savedTurn.kind === "initial") {
				throw corrupt(`research workspace ${savedWorkspace.id} has multiple initial turns`);
			}
			byId.set(savedTurn.id, savedTurn);
		}
		let memberTurns = new Set<string>();
		for (let [index, savedMessage] of messages.entries()) {
			if (savedMessage.workspaceId !== savedWorkspace.id || savedMessage.sequence !== index + 1) {
				throw corrupt(`research workspace ${savedWorkspace.id} has invalid message ordering`);
			}
			let savedTurn = savedMessage.turnId ? byId.get(savedMessage.turnId) : undefined;
			if (savedMessage.turnId && !savedTurn) {
				throw corrupt(`research message ${savedMessage.id} refers to another workspace`);
			}
			if (savedMessage.authorKind === "member") {
				if (
					!savedTurn
					|| memberTurns.has(savedTurn.id)
					|| savedMessage.userId !== savedTurn.requestedBy
					|| savedMessage.text !== savedTurn.question
				) throw corrupt(`research turn ${savedMessage.turnId} has an invalid member message`);
				memberTurns.add(savedTurn.id);
			}
			if (
				savedMessage.authorKind === "agent"
				&& (!savedTurn || savedTurn.answerJobId !== savedMessage.sourceJobId)
			) throw corrupt(`research agent message ${savedMessage.id} has an invalid answer job`);
		}
		if (memberTurns.size !== turns.length) {
			throw corrupt(`research workspace ${savedWorkspace.id} is missing member messages`);
		}
	}
}
