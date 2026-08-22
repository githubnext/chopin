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
	updatedAt: Date;
};

/** Process-lifetime registry row used only by durable agent ownership. */
export type WebSession = {
	id: string;
	userId: string;
	expiresAt: Date;
	createdAt: Date;
};

export type CreateWebSession = WebSession;

export type ChannelRecord = {
	id: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	title: string;
	slug: string;
	createdBy: string;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
};

export type InitialChannel = Omit<
	ChannelSnapshot,
	"channelId" | "revision" | "throughSequence" | "createdAt"
>;

export type CreateChannel =
	& Omit<
		ChannelRecord,
		"slug" | "revision" | "createdAt" | "updatedAt"
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

export type PauseBackgroundJob = ControlBackgroundJob & { reason: string };
export type ResumeBackgroundJob = ControlBackgroundJob & { availableAt: Date };
export type SupersedeBackgroundJob = ControlBackgroundJob & { reason?: string };

export type Lease = {
	name: string;
	owner: string;
	fencing: number;
	expiresAt: Date;
};
