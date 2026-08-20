import type {
	AgentState,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	CommitChannel,
	CommitResult,
	CreateChannel,
	CreateWebSession,
	Lease,
	PutUser,
	RenameChannel,
	RenameResult,
	ReplaceChannel,
	SaveCheckpoint,
	StoredChannel,
	UpdateAgentContext,
	UserRecord,
	WebSession,
} from "./model";

export interface UserStore {
	put(user: PutUser): Promise<UserRecord>;
	get(id: string): Promise<UserRecord | undefined>;
}

export interface SessionStore {
	create(session: CreateWebSession): Promise<void>;
	get(id: string, now: Date): Promise<WebSession | undefined>;
	delete(id: string): Promise<boolean>;
	deleteExpired(now: Date): Promise<number>;
	deleteAll(
		now: Date,
		lease: Lease,
		leaseTtlMs: number,
	): Promise<{ deleted: number; lease: Lease }>;
}

export interface ChannelStore {
	create(channel: CreateChannel): Promise<ChannelRecord>;
	get(id: string): Promise<ChannelRecord | undefined>;
	rename(channel: RenameChannel): Promise<RenameResult>;
	list(repositoryId: string, limit: number, after?: {
		updatedAt: Date;
		id: string;
	}, query?: string): Promise<ChannelPage>;
	scan(repositoryId: string, limit: number, after?: ChannelScanCursor): Promise<ChannelScanPage>;
	claimAgentOwner(channelId: string, sessionId: string, now: Date): Promise<AgentState>;
	clearAgentOwner(
		channelId: string,
		expectedSessionId: string,
		expectedGeneration: number,
		now: Date,
	): Promise<boolean>;
	updateAgentContext(context: UpdateAgentContext): Promise<AgentState>;
}

export interface CollaborationStore {
	load(channelId: string, now: Date): Promise<StoredChannel | undefined>;
	commit(input: CommitChannel): Promise<CommitResult>;
	replace(input: ReplaceChannel): Promise<CommitResult>;
	checkpoint(input: SaveCheckpoint): Promise<void>;
}

export interface LeaseStore {
	acquire(name: string, owner: string, ttlMs: number): Promise<Lease | undefined>;
	renew(lease: Lease, ttlMs: number): Promise<Lease | undefined>;
	release(lease: Lease): Promise<boolean>;
}

/** The complete durable boundary. No provider-specific primitive crosses it. */
export interface StorageAdapter {
	readonly driver: string;
	readonly users: UserStore;
	readonly sessions: SessionStore;
	readonly channels: ChannelStore;
	readonly collaboration: CollaborationStore;
	readonly leases: LeaseStore;

	migrate(): Promise<void>;
	health(): Promise<void>;
	close(): Promise<void>;
}
