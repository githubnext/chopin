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
	createdBy: string;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
};

export type InitialChannel = Omit<
	ChannelSnapshot,
	"channelId" | "revision" | "throughSequence" | "createdAt"
>;

export type CreateChannel = Omit<ChannelRecord, "revision" | "createdAt" | "updatedAt"> & {
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

export type Lease = {
	name: string;
	owner: string;
	fencing: number;
	expiresAt: Date;
};
