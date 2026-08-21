import type {
	AddUserProject,
	AddUserProjectResult,
	AgentState,
	BackgroundJob,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobPage,
	ChannelAgent,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	ClaimBackgroundJobs,
	CommitChannel,
	CommitResult,
	ControlBackgroundJob,
	CreateChannel,
	CreateWebSession,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	Lease,
	PauseBackgroundJob,
	PutUser,
	RecordNavigationVisit,
	RenameChannel,
	RenameResult,
	RenewBackgroundJob,
	ReplaceChannel,
	RequeueBackgroundJob,
	ResumeBackgroundJob,
	SaveCheckpoint,
	SettleBackgroundJob,
	StoredChannel,
	SupersedeBackgroundJob,
	UpdateAgentContext,
	UserNavigation,
	UserProject,
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

export interface NavigationStore {
	projects(userId: string): Promise<UserProject[]>;
	addProject(input: AddUserProject): Promise<AddUserProjectResult>;
	get(userId: string): Promise<UserNavigation | undefined>;
	setLastDocument(
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation>;
	recordVisit(input: RecordNavigationVisit): Promise<UserNavigation>;
}

export interface ChannelStore {
	create(channel: CreateChannel): Promise<ChannelRecord>;
	get(id: string): Promise<ChannelRecord | undefined>;
	resolve(repositoryId: string, slug: string): Promise<ChannelRecord | undefined>;
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
	readAgent(channelId: string, now: Date): Promise<ChannelAgent | undefined>;
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

export interface BackgroundJobStore {
	enqueue(input: EnqueueBackgroundJob): Promise<{ job: BackgroundJob; repeated: boolean }>;
	claim(input: ClaimBackgroundJobs): Promise<BackgroundJob[]>;
	renew(input: RenewBackgroundJob): Promise<BackgroundJob>;
	requeue(input: RequeueBackgroundJob): Promise<BackgroundJob>;
	settle(input: SettleBackgroundJob): Promise<BackgroundJobDetail>;
	pause(input: PauseBackgroundJob): Promise<BackgroundJob>;
	resume(input: ResumeBackgroundJob): Promise<BackgroundJob>;
	fail(input: FailBackgroundJob): Promise<BackgroundJob>;
	cancel(input: ControlBackgroundJob): Promise<BackgroundJob>;
	supersede(input: SupersedeBackgroundJob): Promise<BackgroundJob>;
	list(
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<BackgroundJobPage | undefined>;
	get(channelId: string, jobId: string): Promise<BackgroundJobDetail | undefined>;
}

/** The complete durable boundary. No provider-specific primitive crosses it. */
export interface StorageAdapter {
	readonly driver: string;
	readonly users: UserStore;
	readonly sessions: SessionStore;
	readonly navigation: NavigationStore;
	readonly channels: ChannelStore;
	readonly collaboration: CollaborationStore;
	readonly leases: LeaseStore;
	readonly jobs: BackgroundJobStore;

	migrate(): Promise<void>;
	health(): Promise<void>;
	close(): Promise<void>;
}
