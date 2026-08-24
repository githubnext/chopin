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

/** Process-lifetime registry row used only by durable agent ownership. */
export type WebSession = {
	id: string;
	userId: string;
	expiresAt: Date;
	createdAt: Date;
};

export type CreateWebSession = WebSession;

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
};

export type InitialChannel = Omit<
	ChannelSnapshot,
	"channelId" | "revision" | "throughSequence" | "createdAt"
>;

export type CreateChannel =
	& Omit<
		ChannelRecord,
		"slug" | "revision" | "createdAt" | "updatedAt" | "archivedAt" | "description"
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
	channelId: string;
	lease: Lease;
	expectedRevision: number;
	operationId: string;
	epoch: string;
	update?: Uint8Array;
	sidecar?: JsonValue;
	events: EventInput[];
	now: Date;
	/** Lifecycle and shutdown maintenance may persist after document archival. */
	allowArchived?: boolean;
};

export type CommitResult = {
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
	createdBy: string;
	confirmedBy: string | undefined;
	revision: number;
	idempotencyKey: string;
	fingerprint: string;
	createdAt: Date;
	updatedAt: Date;
};

export type ResearchWorkspaceSummary = ResearchWorkspace;

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
