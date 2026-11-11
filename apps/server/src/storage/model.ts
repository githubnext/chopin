import { StorageError } from "./errors";

/** Values storage adapters may persist without knowing their domain schema. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type UserRecord = {
	id: string;
	login: string;
	avatarUrl: string;
	createdAt: Date;
	updatedAt: Date;
};

export type PutUser = Omit<UserRecord, "createdAt" | "updatedAt"> & {
	now: Date;
};

/** Image bytes uploaded to one document, addressed by their SHA-256. */
export type StoredImage = {
	channelId: string;
	sha256: string;
	mimeType: string;
	bytes: Uint8Array;
	size: number;
	uploadedBy: string;
	createdAt: Date;
};

export type PutImage = Omit<StoredImage, "size" | "createdAt"> & { now: Date };

/**
 * An image or text file uploaded to a document's Chat. It is only the uploader's until a message
 * is sent with it (`entryId` is then that message's id, and `position` its place among the
 * message's files); a person who can read the document reads it from then on.
 */
export type StoredChatAttachment = {
	id: string;
	channelId: string;
	name: string;
	kind: "image" | "file";
	/** What the bytes are, as sniffed on arrival, never what the sender claimed. */
	mimeType: string;
	bytes: Uint8Array;
	size: number;
	uploadedBy: string;
	createdAt: Date;
	entryId?: string;
	position?: number;
};

export type PutChatAttachment =
	& Omit<StoredChatAttachment, "size" | "createdAt" | "entryId" | "position">
	& {
		now: Date;
	};

/** What a person has uploaded to one document and not yet sent. */
export type StagedChatAttachments = { count: number; bytes: number };

/** One stage of a workflow run whose card Chat shows, as its run last reported it. */
export type RunStageRecord = {
	id: string;
	name: string;
	parentIds?: string[];
	kind?: "tool";
	status:
		| "pending"
		| "running"
		| "awaiting_input"
		| "paused"
		| "blocked"
		| "completed"
		| "failed"
		| "skipped"
		| "stopped";
	/** Seconds since the epoch. */
	started?: number;
	ended?: number;
};

export type PutRunStages = {
	channelId: string;
	runId: string;
	stages: RunStageRecord[];
	/** The run keeps only these stages, in this order, instead of adding them to its own. */
	replace?: boolean;
};

/** A saved answer to a decision the Planner left open, waiting for a Planner turn to act on it. */
export type DecisionAnswer = {
	decisionId: string;
	/** The decision's saved generation; a reopened and saved again decision has a newer one. */
	generation: number;
	savedAt: Date;
	/** The turn claimed to carry it, whose notice id it is; absent while it waits for one. */
	turnId?: string;
};

export type SaveDecisionAnswer = {
	channelId: string;
	decisionId: string;
	generation: number;
	savedAt: Date;
};

/**
 * One editing session in a document's history and the source it left behind.
 * Consecutive edits by the same author within the idle gap extend one session.
 */
export type DocumentVersion = {
	id: string;
	channelId: string;
	/** The person whose edits these were; absent when Chopin itself wrote them. */
	authorId?: string;
	authorLogin?: string;
	authorAvatarUrl?: string;
	revision: number;
	sourceHash: string;
	startedAt: Date;
	updatedAt: Date;
	/** A one-line account of the session, present only while it describes the current source. */
	summary?: string;
};

export type StoredDocumentVersion = DocumentVersion & { source: string };

export type RecordDocumentVersion = {
	channelId: string;
	authorId?: string;
	revision: number;
	source: string;
	sourceHash: string;
	now: Date;
	/** Edits by the same author closer together than this extend the latest session. */
	idleMs: number;
	/** Never extends the latest session, as for a restore. */
	newSession?: boolean;
};

export type SummarizeDocumentVersion = {
	channelId: string;
	id: string;
	/** The source the summary describes; a session that has moved on since keeps none. */
	sourceHash: string;
	summary: string;
};

export type UserProject = {
	userId: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	position: number;
	addedAt: Date;
};

export type AddUserProject = Omit<UserProject, "position" | "addedAt"> & { now: Date };

export type AddUserProjectResult = {
	project: UserProject;
	added: boolean;
};

export type RecordNavigationVisit = AddUserProject & {
	documentId: string;
};

export type UserNavigation = {
	userId: string;
	lastDocumentId: string | undefined;
	revision: number;
	updatedAt: Date;
};

export type UserNavigationSnapshot = {
	projects: UserProject[];
	navigation: UserNavigation | undefined;
	lastDocumentRepositoryId: string | undefined;
};

export type CompareNavigationResult = {
	navigation: UserNavigation;
	updated: boolean;
};

/** Public session metadata, also referenced by durable agent ownership. */
export type WebSession = {
	id: string;
	userId: string;
	expiresAt: Date;
	createdAt: Date;
};

/** Opaque authenticated ciphertext; storage never receives plaintext GitHub credentials. */
export type SessionCredentials = {
	secretHash: Uint8Array;
	ciphertext: Uint8Array;
	revision: number;
};

export type StoredWebSession = WebSession & { credentials?: SessionCredentials };
export type CreateWebSession = StoredWebSession;

/** One checkout a paired machine serves. */
export type MachineRepository = {
	repositoryId: string;
	repository: string;
	commit: string;
	branch?: string;
};

/** Opaque authenticated ciphertext of a machine's own GitHub App user token pair. */
export type MachineCredentials = {
	ciphertext: Uint8Array;
	revision: number;
};

/**
 * A local agent paired once by its owner. Storage holds a hash of its bearer token, never the
 * token, and its GitHub credentials only as ciphertext.
 */
export type StoredMachine = {
	id: string;
	userId: string;
	label: string;
	repositories: MachineRepository[];
	autoRun: boolean;
	/**
	 * The owner lets teammates choose this machine for a document: its Planner, builds and runs
	 * then run here as the owner, and Default machine may run the Planner of a teammate's document
	 * whose creator has no machine of their own that can. Off unless the owner turns it on.
	 */
	shared?: boolean;
	tokenHash: Uint8Array;
	credentials?: MachineCredentials;
	createdAt: Date;
	lastSeenAt: Date;
	/** GitHub refused its stored authorization; the owner must pair it again. */
	reauthorizeAt?: Date;
	revokedAt?: Date;
};
export type CreateMachine = Omit<StoredMachine, "reauthorizeAt" | "revokedAt">;

/**
 * Which of a person's machines works on one document for them. No row is the automatic choice:
 * their live connection last used for the document, else the first idle one.
 */
export type MachineChoice = { channelId: string; userId: string; machineId: string };
/** The one machine a person prefers when a document is on Automatic. */
export type MachineFavorite = { userId: string; machineId: string };

export type ChannelDescription = {
	value: string;
	revision: number;
	planRevision: number;
	sourceHash: string;
	generatorVersion: 1;
	jobId: string;
	updatedAt: Date;
};

export type ChannelRecord = {
	id: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	parentChannelId?: string;
	title: string;
	slug: string;
	createdBy: string;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
	archivedAt?: Date;
	description?: ChannelDescription;
	unansweredDecisions: number;
};

export type ChannelDecisionCount = Pick<ChannelRecord, "revision" | "unansweredDecisions"> & {
	channelId: string;
};

export type InitialChannel = Omit<
	ChannelSnapshot,
	"channelId" | "revision" | "throughSequence" | "createdAt"
>;

export type CreateChannel =
	& Omit<
		ChannelRecord,
		| "slug"
		| "revision"
		| "createdAt"
		| "updatedAt"
		| "archivedAt"
		| "description"
		| "unansweredDecisions"
	>
	& {
		now: Date;
		/** A complete revision-zero checkpoint published in the channel's creation transaction. */
		initial?: InitialChannel;
	};

export type RenameChannel = {
	id: string;
	title: string;
	now: Date;
};

export type RenameResult = {
	channel: ChannelRecord;
	changed: boolean;
};

export type ChannelArchiveInput = {
	id: string;
	now: Date;
};

export type ChannelArchiveResult = {
	channel: ChannelRecord;
	changed: boolean;
};

export type PublishChannelDescription = {
	channelId: string;
	description: string;
	planRevision: number;
	sourceHash: string;
	generatorVersion: 1;
	jobId: string;
	now: Date;
	lease: Lease;
};

export type PublishChannelDescriptionResult = {
	channel: ChannelRecord;
	changed: boolean;
};

export type ChannelCursor = {
	updatedAt: Date;
	id: string;
};

export type ChannelPage = {
	channels: ChannelRecord[];
	next?: ChannelCursor;
};

export type ChannelScanCursor = {
	createdAt: Date;
	id: string;
};

export type ChannelScanPage = {
	channels: ChannelRecord[];
	next?: ChannelScanCursor;
};

export type ChannelSnapshot = {
	channelId: string;
	generation: string;
	revision: number;
	throughSequence: number;
	epoch: string;
	source: string;
	sourceHash: string;
	document: Uint8Array;
	sidecar: JsonValue;
	createdAt: Date;
};

export type ChannelUpdate = {
	channelId: string;
	sequence: number;
	revision: number;
	epoch: string;
	update: Uint8Array;
};

export type StoredEvent = {
	id: string;
	channelId: string;
	sequence: number;
	ordinal: number;
	kind: string;
	payload: JsonValue;
	createdAt: Date;
};

export type EventInput = Omit<StoredEvent, "channelId" | "sequence" | "ordinal">;

export type AgentStatus = "ready" | "unavailable";

export type AgentState = {
	channelId: string;
	ownerSessionId: string | undefined;
	generation: number;
	summary: string;
	transcriptCursor: number;
	status: AgentStatus;
	updatedAt: Date;
};

export type ChannelAgent = {
	channel: ChannelRecord;
	agent: AgentState | undefined;
};

export type StoredChannel = {
	channel: ChannelRecord;
	latestSequence: number;
	snapshot: ChannelSnapshot | undefined;
	updates: ChannelUpdate[];
	events: StoredEvent[];
	sidecar: JsonValue;
	agent: AgentState | undefined;
};

export type CommitChannel = {
	/** Finalize the new rewrite receipt using this transaction's canonical slug. */
	finalizeTitleReceipt?: boolean;
	/** Authored title committed with the document delta; absent for sidecar-only callers. */
	title?: string;
	channelId: string;
	lease: Lease;
	expectedRevision: number;
	operationId: string;
	epoch: string;
	update?: Uint8Array;
	sidecar?: JsonValue;
	events: EventInput[];
	now: Date;
	/** Browser Research reference changes that must remain authorized at commit time. */
	researchProjections?: ResearchProjectionChange[];
	/** Lifecycle and shutdown maintenance may persist after document archival. */
	allowArchived?: boolean;
	/**
	 * Deferred Planner turns written or moved in this commit's transaction, so a request is
	 * durable no later than the entry that acknowledges it. A repeated operation applies none.
	 */
	deferredTurns?: DeferredTurnChange[];
};

export type ResearchProjectionChange = { id: string; action: "add" | "remove" };

/** A rejected browser projection is an invalid batch, not a storage outage. */
export class ResearchProjectionConflict extends StorageError {
	constructor(id: string) {
		super("conflict", `research projection ${id} is no longer authorized`);
		this.name = "ResearchProjectionConflict";
	}
}

export type CommitResult = {
	/** What each of the commit's `deferredTurns` did, in the same order; absent for a repeat. */
	deferredTurns?: DeferredTurnOutcome[];
	sidecar?: JsonValue;
	/** Present when the operation synchronizes an authored title. */
	channel?: ChannelRecord;
	revision: number;
	sequence: number;
	repeated: boolean;
};

export type SaveCheckpoint = Omit<ChannelSnapshot, "channelId"> & {
	channelId: string;
	lease: Lease;
	expectedRevision: number;
};

/** Atomically rotate a channel to a complete new Yjs epoch. */
export type ReplaceChannel = {
	title?: string;
	channelId: string;
	lease: Lease;
	expectedRevision: number;
	operationId: string;
	generation: string;
	epoch: string;
	source: string;
	sourceHash: string;
	document: Uint8Array;
	sidecar: JsonValue;
	now: Date;
};

export type UpdateAgentContext = {
	channelId: string;
	ownerSessionId: string;
	generation: number;
	summary: string;
	transcriptCursor: number;
	status: AgentStatus;
	now: Date;
};

export type BackgroundJobOrigin = "scheduler" | "planner" | "user";

export const BACKGROUND_JOB_PROGRESS_LIMIT = 32;
export const BACKGROUND_JOB_PROGRESS_LABEL_LIMIT = 160;

export type BackgroundJobProgressState = "started" | "completed" | "interrupted";

export type BackgroundJobProgress = {
	revision: number;
	attempt: number;
	stage: string;
	label: string;
	state: BackgroundJobProgressState;
	reason?: string;
	createdAt: Date;
};

export type BackgroundJobState =
	| "pending"
	| "paused"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "superseded";

const BACKGROUND_JOB_STATES = new Set<BackgroundJobState>([
	"pending",
	"paused",
	"running",
	"completed",
	"failed",
	"cancelled",
	"superseded",
]);

export function isBackgroundJobState(value: unknown): value is BackgroundJobState {
	return typeof value === "string" && BACKGROUND_JOB_STATES.has(value as BackgroundJobState);
}

export type ResearchAttemptDisposition = "active" | "retryable" | "settled";

/** One canonical retry policy, rechecked by storage while its job rows are locked. */
export function researchAttemptDisposition(
	states: readonly BackgroundJobState[],
): ResearchAttemptDisposition {
	if (states.some(state => state === "pending" || state === "paused" || state === "running")) {
		return "active";
	}
	if (
		states.length === 0
		|| states.some(state => state === "failed" || state === "cancelled" || state === "superseded")
	) return "retryable";
	return "settled";
}

export type BackgroundJob = {
	id: string;
	channelId: string;
	type: string;
	version: number;
	origin: BackgroundJobOrigin;
	targetKey: string;
	targetGeneration: number;
	idempotencyKey: string;
	fingerprint: string;
	input: JsonValue;
	state: BackgroundJobState;
	revision: number;
	attempts: number;
	failures: number;
	claimGeneration: number;
	claimOwner: string | undefined;
	claimBinding: JsonValue | undefined;
	claimExpiresAt: Date | undefined;
	availableAt: Date;
	reason: string | undefined;
	progress: BackgroundJobProgress[];
	createdAt: Date;
	updatedAt: Date;
};

export type BackgroundJobTarget = {
	channelId: string;
	targetKey: string;
	generation: number;
};

export type BackgroundJobArtifact = {
	jobId: string;
	revision: number;
	value: JsonValue;
	createdAt: Date;
};

export type BackgroundJobSummary =
	& Omit<
		BackgroundJob,
		"claimBinding" | "fingerprint" | "idempotencyKey" | "input"
	>
	& { subject?: string };

export type BackgroundJobCursor = {
	createdAt: Date;
	id: string;
};

export type BackgroundJobPage = {
	revision: number;
	jobs: BackgroundJobSummary[];
	next?: BackgroundJobCursor;
};

export type BackgroundJobDetail = {
	revision: number;
	target: BackgroundJobTarget;
	job: BackgroundJob;
	artifact: BackgroundJobArtifact | undefined;
};

export type EnqueueBackgroundJob = {
	id: string;
	channelId: string;
	type: string;
	version: number;
	origin: BackgroundJobOrigin;
	targetKey: string;
	idempotencyKey: string;
	fingerprint: string;
	input: JsonValue;
	availableAt: Date;
	now: Date;
	lease: Lease;
};

export type ClaimBackgroundJobs = {
	channelId?: string;
	claimOwner: string;
	count: number;
	ttlMs: number;
	now: Date;
	lease: Lease;
};

export type ClaimedBackgroundJob = {
	channelId: string;
	jobId: string;
	claimOwner: string;
	claimGeneration: number;
	now: Date;
	lease: Lease;
};

export type RenewBackgroundJob = ClaimedBackgroundJob & {
	expectedRevision: number;
	ttlMs: number;
	claimBinding: JsonValue | undefined;
};

export type AppendBackgroundJobProgress = ClaimedBackgroundJob & {
	stage: string;
	label: string;
	state: BackgroundJobProgressState;
	reason?: string;
};

export type SettleBackgroundJob = ClaimedBackgroundJob & {
	artifact: JsonValue;
};

export type RequeueBackgroundJob = ClaimedBackgroundJob & {
	availableAt: Date;
	reason: string;
	countFailure: boolean;
};

export type FailBackgroundJob = ClaimedBackgroundJob & {
	reason: string;
};

export type ControlBackgroundJob = {
	channelId: string;
	jobId: string;
	expectedRevision: number;
	now: Date;
	lease: Lease;
};

export type CancelBackgroundJob = Omit<ControlBackgroundJob, "expectedRevision"> & {
	allowArchived?: boolean;
};

export type PauseBackgroundJob = ControlBackgroundJob & { reason: string };
export type ResumeBackgroundJob = ControlBackgroundJob & { availableAt: Date };
export type SupersedeBackgroundJob = ControlBackgroundJob & { reason?: string };

export type ResearchWorkspaceOrigin = "inline" | "sidebar" | "planner";

export type ResearchWorkspace = {
	id: string;
	channelId: string;
	publishedChannelId: string | undefined;
	title: string;
	proposedQuestion: string;
	confirmedQuery: string | undefined;
	origin: ResearchWorkspaceOrigin;
	originMessageId: string | undefined;
	/** Present only for Planner requests that must be placed in the parent document. */
	inlineReference?: "pending" | "placed";
	createdBy: string;
	confirmedBy: string | undefined;
	revision: number;
	idempotencyKey: string;
	fingerprint: string;
	createdAt: Date;
	updatedAt: Date;
};

export type ResearchWorkspaceSummary = ResearchWorkspace;

export type ResearchTerminalRecovery = {
	id: string;
	channelId: string;
	jobId: string;
};

export const RESEARCH_REPOSITORY_CHANNEL_LIMIT = 1_000;
export const RESEARCH_REPOSITORY_WORKSPACE_LIMIT = 500;
export const RESEARCH_REPOSITORY_CHANNEL_WORKSPACE_LIMIT = 100;

export type ResearchWorkspaceRepositoryChannel = Pick<
	ChannelRecord,
	"id" | "repositoryId" | "repositoryOwner" | "repositoryName" | "title" | "slug"
>;

export type ResearchWorkspaceRepositoryGroup = {
	channel: ResearchWorkspaceRepositoryChannel;
	workspaces: ResearchWorkspaceSummary[];
};

export type ResearchWorkspaceRepositoryList = {
	channels: ResearchWorkspaceRepositoryGroup[];
	truncated: boolean;
};

export type ResearchTurnKind = "initial" | "follow-up" | "search-more";

export type ResearchTurn = {
	id: string;
	workspaceId: string;
	ordinal: number;
	kind: ResearchTurnKind;
	requestId: string;
	fingerprint: string;
	question: string;
	requestedBy: string;
	evidenceJobId: string | undefined;
	answerJobId: string | undefined;
	createdAt: Date;
	updatedAt: Date;
};

export function researchProjectionAllowed(
	channelId: string,
	change: ResearchProjectionChange,
	workspace:
		| Pick<ResearchWorkspace, "id" | "channelId" | "origin" | "publishedChannelId">
		| undefined,
	initial:
		| Pick<
			ResearchTurn,
			"id" | "workspaceId" | "kind" | "evidenceJobId" | "answerJobId"
		>
		| undefined,
	job: Pick<BackgroundJob, "channelId" | "type" | "targetKey" | "state"> | undefined,
): boolean {
	if (!workspace || workspace.id !== change.id || workspace.channelId !== channelId) return false;
	if (!initial || initial.kind !== "initial" || initial.workspaceId !== change.id) return false;
	if (change.action === "add" && workspace.origin !== "inline") return false;
	let role = initial.answerJobId ? "answer" : "evidence";
	let jobId = initial.answerJobId ?? initial.evidenceJobId;
	if (
		jobId && (
			!job || job.channelId !== channelId || job.type !== `research-${role}`
			|| job.targetKey !== `research-${role}:workspace:${change.id}:turn:${initial.id}:${role}`
		)
	) return false;
	let terminal = job && ["failed", "cancelled", "superseded"].includes(job.state);
	return change.action === "add"
		? !!job && !workspace.publishedChannelId
			&& ["pending", "paused", "running", "completed"].includes(job.state)
		: !!workspace.publishedChannelId || !!terminal || !jobId;
}

export type ResearchMessageAuthorKind = "member" | "agent" | "system";

export type ResearchMessage = {
	id: string;
	workspaceId: string;
	sequence: number;
	turnId: string | undefined;
	authorKind: ResearchMessageAuthorKind;
	userId: string | undefined;
	userHandle: string | undefined;
	text: string;
	sourceJobId: string | undefined;
	createdAt: Date;
};

export type ResearchWorkspaceDetail = {
	workspace: ResearchWorkspace;
	turns: ResearchTurn[];
	messages: ResearchMessage[];
};

export type CreateResearchWorkspace = {
	id: string;
	channelId: string;
	title: string;
	proposedQuestion: string;
	origin: ResearchWorkspaceOrigin;
	originMessageId?: string;
	createdBy: string;
	idempotencyKey: string;
	fingerprint: string;
	now: Date;
	lease: Lease;
};

export type CreateResearchWorkspaceResult = {
	workspace: ResearchWorkspace;
	repeated: boolean;
};

export type StartResearchWorkspace = {
	id: string;
	channelId: string;
	title: string;
	question: string;
	origin: Extract<ResearchWorkspaceOrigin, "inline" | "planner">;
	originMessageId?: string;
	inlineReference?: "pending";
	createdBy: string;
	createdByHandle?: string;
	turnId: string;
	messageId: string;
	requestId: string;
	idempotencyKey: string;
	fingerprint: string;
	now: Date;
	lease: Lease;
};

export type StartResearchWorkspaceResult = {
	workspace: ResearchWorkspace;
	turn: ResearchTurn;
	message: ResearchMessage;
	repeated: boolean;
};

export type ConfirmResearchWorkspace = {
	channelId: string;
	workspaceId: string;
	turnId: string;
	messageId: string;
	requestId: string;
	fingerprint: string;
	confirmedQuery: string;
	confirmedBy: string;
	confirmedByHandle?: string;
	now: Date;
	lease: Lease;
};

export type ConfirmResearchWorkspaceResult = {
	workspace: ResearchWorkspace;
	turn: ResearchTurn;
	message: ResearchMessage;
	repeated: boolean;
};

export type AppendResearchTurn = {
	channelId: string;
	workspaceId: string;
	turnId: string;
	messageId: string;
	kind: Exclude<ResearchTurnKind, "initial">;
	requestId: string;
	fingerprint: string;
	question: string;
	requestedBy: string;
	requestedByHandle?: string;
	now: Date;
	lease: Lease;
};

export type AppendResearchTurnResult = ConfirmResearchWorkspaceResult;

export type ResearchJobRole = "evidence" | "answer";

export type LinkResearchTurnJob = {
	channelId: string;
	workspaceId: string;
	turnId: string;
	role: ResearchJobRole;
	jobId: string;
	now: Date;
	lease: Lease;
};

export type LinkResearchTurnJobResult = {
	workspace: ResearchWorkspace;
	turn: ResearchTurn;
	repeated: boolean;
};

export type ResetInitialResearchAttempt = {
	channelId: string;
	workspaceId: string;
	expectedEvidenceJobId: string | undefined;
	expectedAnswerJobId: string | undefined;
	now: Date;
	lease: Lease;
};

export type ResetInitialResearchAttemptResult = LinkResearchTurnJobResult;

export type AppendResearchAgentMessage = {
	channelId: string;
	workspaceId: string;
	id: string;
	turnId: string;
	userId?: string;
	userHandle?: string;
	text: string;
	sourceJobId: string;
	now: Date;
	lease: Lease;
};

export type AppendResearchAgentMessageResult = {
	workspace: ResearchWorkspace;
	message: ResearchMessage;
	repeated: boolean;
};

export type PublishInitialResearchReport = {
	channelId: string;
	workspaceId: string;
	answerJobId: string;
	title: string;
	initial: InitialChannel;
	now: Date;
	lease: Lease;
};

export type PublishInitialResearchReportResult = {
	workspace: ResearchWorkspace;
	channel: ChannelRecord;
	repeated: boolean;
};

export type Lease = {
	name: string;
	owner: string;
	fencing: number;
	expiresAt: Date;
};

/**
 * A lease as a plain read finds it, without taking it or queueing behind its holder. `free` is
 * judged on the storage's own clock: the lease was released or its time ran out.
 */
export type LeasePeek = { lease: Lease; free: boolean };

/**
 * A question a remote Planner's client still waits on, as a restart keeps it: the kind of request
 * and the decisions it asked, which is what its answer is built from in the process that takes over.
 */
export type PlannerAskedInput = {
	request: string;
	method: "questionnaire" | "confirm" | "select" | "input" | "editor";
	decisions: string[];
};

/** What one session of a remote Planner's client keeps across a link that dropped. */
export type PlannerHeldSession = {
	id: string;
	/** Request ids of the questions the client still waits on. */
	waiting: string[];
	/** What each of those whose decisions exist needs to be answered again after a restart. */
	asked?: PlannerAskedInput[];
	/** Answers the client has not acknowledged. */
	owed: JsonValue[];
	/** Stops pressed while the link was down, for the client to hear first. */
	stops: JsonValue[];
};

/**
 * A document's remote Planner as its link left it, for the process that takes over to rebuild.
 * Holds nothing a person typed and no secret: the owner's login is a session id.
 */
export type PlannerLinkHold = {
	channelId: string;
	userId: string;
	login: string;
	/**
	 * The browser login session that owns the document's Planner; the hold goes with it. Absent
	 * for a paired machine's hold, whose delegated login lasts only as long as one process: the
	 * machine's next attach makes a new one, and the hold goes with the machine.
	 */
	ownerSessionId?: string;
	/** The stored Planner owner's generation the hold was made under. */
	generation: number;
	/** The paired machine whose delegated login owns the document, by id and label. */
	machineId?: string;
	machine?: string;
	/** Empty for a link that was live with nothing to resume. */
	sessions: PlannerHeldSession[];
	suspendedAt: Date;
	/** Set when a cut closed the link: until then a returning client is not shown as gone. */
	handoverUntil?: Date;
};

export type StoredPlannerLinkHold = PlannerLinkHold & {
	/** The writer lease the hold was last written under. */
	fencing: number;
};

/**
 * The model and thinking level somebody chose for a document's Planner, one row per document and
 * shared by everyone who opens it. A field left out means the Planner's own default. Nothing
 * checks the strings here: the server resolves them against the catalog the harness reports at
 * the turn that uses them, and a model that has gone stays stored until somebody chooses again.
 */
export type PlannerModelChoice = {
	channelId: string;
	model?: string;
	/** The catalog's name for the chosen model, when known. */
	modelName?: string;
	thinkingLevel?: string;
	/** Who chose it last. */
	userId: string;
	updatedAt: Date;
};

/** A paired machine's Planner credential, known by the digest of its token and never the token. */
export type PlannerCredential = {
	/** SHA-256 of the credential. */
	digest: Uint8Array;
	machineId: string;
	channelId: string;
	expiresAt: Date;
};

export type McpSession = {
	id: string;
	userId: string;
	clientName: string;
	clientVersion: string;
	createdAt: Date;
	lastSeenAt: Date;
};

export const DEFERRED_TURN_KINDS = [
	"composer",
	"invoke_planner",
	"invoke_system",
	"comment",
	"draft",
] as const;
export type DeferredTurnKind = (typeof DEFERRED_TURN_KINDS)[number];

export const DEFERRED_TURN_STATES = [
	"waiting",
	"started",
	"ended",
	"interrupted",
	"cancelled",
] as const;
export type DeferredTurnState = (typeof DEFERRED_TURN_STATES)[number];

/**
 * Why Chopin cancelled a request it could not run, for what its sender is told: the agent was
 * reset, the sender can no longer write, or the document is gone. A request its sender took back
 * or a comment whose thread was resolved has none.
 */
export const DEFERRED_CANCEL_REASONS = ["agent", "access", "unavailable"] as const;
export type DeferredCancelReason = (typeof DEFERRED_CANCEL_REASONS)[number];

/** An acknowledged Planner request whose turn had not started, kept until it runs or is resolved. */
export type DeferredTurn = {
	id: string;
	/** The root document whose Chat and Planner the request is for. */
	documentId: string;
	/** What the acknowledgement named; unique within the document. */
	requestId: string;
	kind: DeferredTurnKind;
	handle: string;
	userId: string;
	/** Empty for a comment, whose prompt is built from its thread when it starts. */
	text: string;
	references: JsonValue[];
	/** A composer message's destination and fingerprints, for recognising a retried send. */
	delivery?: JsonValue;
	focusChannelId?: string;
	focusTitle?: string;
	/** The comment thread, and the child holding it when it is not in the document. */
	threadId?: string;
	threadChannelId?: string;
	/** The revision a task draft was asked for. */
	planRevision?: number;
	claimantSessionId?: string;
	ownerSessionIdAtAccept?: string;
	state: DeferredTurnState;
	createdAt: Date;
	/** The writer lease the latest transition was written under. */
	fencing: number;
	resolvedAt?: Date;
	/** Set only on a cancelled turn, when Chopin cancelled it. */
	cancelReason?: DeferredCancelReason;
};

export type NewDeferredTurn = Omit<
	DeferredTurn,
	"state" | "fencing" | "resolvedAt" | "cancelReason"
>;

/**
 * Moves one turn from the state it is expected to be in. Only `waiting` to `started` or
 * `cancelled`, and `started` to `ended` or `interrupted`, are legal; anything else changes nothing.
 */
export type DeferredTurnTransition = {
	id: string;
	from: DeferredTurnState;
	to: DeferredTurnState;
	at: Date;
	/** Why Chopin cancelled it; kept only with a move to `cancelled`. */
	reason?: DeferredCancelReason;
};

export type DeferredTurnChange =
	| { action: "insert"; turn: NewDeferredTurn }
	| ({ action: "transition" } & DeferredTurnTransition);

export type DeferredTurnOutcome =
	| {
		action: "insert";
		/**
		 * `repeated`: the document already has this request, returned as it first was.
		 * `thread-waiting`: a comment thread already has a waiting turn, returned, and nothing was
		 * written.
		 */
		status: "inserted" | "repeated" | "thread-waiting";
		turn: DeferredTurn;
	}
	| { action: "transition"; changed: true; turn: DeferredTurn }
	| {
		action: "transition";
		changed: false;
		/** No such row, a pair the states do not allow, or a row not in the state asked for. */
		reason: "missing" | "illegal" | "state";
		turn?: DeferredTurn;
	};

export function legalDeferredTransition(from: DeferredTurnState, to: DeferredTurnState): boolean {
	return (from === "waiting" && (to === "started" || to === "cancelled"))
		|| (from === "started" && (to === "ended" || to === "interrupted"));
}
