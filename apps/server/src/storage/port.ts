import type {
	AddUserProject,
	AddUserProjectResult,
	AgentState,
	AppendBackgroundJobProgress,
	AppendResearchAgentMessage,
	AppendResearchAgentMessageResult,
	AppendResearchTurn,
	AppendResearchTurnResult,
	BackgroundJob,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobPage,
	CancelBackgroundJob,
	ChannelAgent,
	ChannelArchiveInput,
	ChannelArchiveResult,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	ClaimBackgroundJobs,
	CommitChannel,
	CommitResult,
	CompareNavigationResult,
	ConfirmResearchWorkspace,
	ConfirmResearchWorkspaceResult,
	CreateChannel,
	CreateResearchWorkspace,
	CreateResearchWorkspaceResult,
	CreateWebSession,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	Lease,
	LinkResearchTurnJob,
	LinkResearchTurnJobResult,
	PauseBackgroundJob,
	PublishChannelDescription,
	PublishChannelDescriptionResult,
	PublishInitialResearchReport,
	PublishInitialResearchReportResult,
	PutUser,
	RecordNavigationVisit,
	RenameChannel,
	RenameResult,
	RenewBackgroundJob,
	ReplaceChannel,
	RequeueBackgroundJob,
	ResearchTurn,
	ResearchWorkspaceDetail,
	ResearchWorkspaceRepositoryList,
	ResearchWorkspaceSummary,
	ResumeBackgroundJob,
	SaveCheckpoint,
	SettleBackgroundJob,
	StartResearchWorkspace,
	StartResearchWorkspaceResult,
	StoredChannel,
	SupersedeBackgroundJob,
	UpdateAgentContext,
	UserNavigation,
	UserNavigationSnapshot,
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
	snapshot(userId: string): Promise<UserNavigationSnapshot>;
	projects(userId: string): Promise<UserProject[]>;
	firstDocument(userId: string, repositoryIds: string[]): Promise<string | undefined>;
	addProject(input: AddUserProject): Promise<AddUserProjectResult>;
	get(userId: string): Promise<UserNavigation | undefined>;
	setLastDocument(
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation>;
	setLastDocumentIfCurrent(
		userId: string,
		expectedRevision: number | undefined,
		documentId: string | undefined,
		now: Date,
	): Promise<CompareNavigationResult>;
	recordVisit(input: RecordNavigationVisit): Promise<UserNavigation>;
}

export interface ChannelStore {
	/** Creates a top-level channel or one repository-local, non-recursive child. */
	create(input: CreateChannel): Promise<ChannelRecord>;
	get(id: string): Promise<ChannelRecord | undefined>;
	resolve(repositoryId: string, slug: string): Promise<ChannelRecord | undefined>;
	rename(channel: RenameChannel): Promise<RenameResult>;
	archive(input: ChannelArchiveInput): Promise<ChannelArchiveResult>;
	restore(input: ChannelArchiveInput): Promise<ChannelArchiveResult>;
	delete(id: string): Promise<boolean>;
	publishDescription(input: PublishChannelDescription): Promise<PublishChannelDescriptionResult>;
	list(
		repositoryId: string,
		limit: number,
		after?: {
			updatedAt: Date;
			id: string;
		},
		query?: string,
		includeArchived?: boolean,
	): Promise<ChannelPage>;
	scan(
		repositoryId: string,
		limit: number,
		after?: ChannelScanCursor,
		includeArchived?: boolean,
	): Promise<ChannelScanPage>;
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
	appendProgress(input: AppendBackgroundJobProgress): Promise<BackgroundJob>;
	requeue(input: RequeueBackgroundJob): Promise<BackgroundJob>;
	settle(input: SettleBackgroundJob): Promise<BackgroundJobDetail>;
	pause(input: PauseBackgroundJob): Promise<BackgroundJob>;
	resume(input: ResumeBackgroundJob): Promise<BackgroundJob>;
	fail(input: FailBackgroundJob): Promise<BackgroundJob>;
	cancel(input: CancelBackgroundJob): Promise<BackgroundJob>;
	supersede(input: SupersedeBackgroundJob): Promise<BackgroundJob>;
	list(
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<BackgroundJobPage | undefined>;
	get(channelId: string, jobId: string): Promise<BackgroundJobDetail | undefined>;
}

export interface ResearchWorkspaceStore {
	create(input: CreateResearchWorkspace): Promise<CreateResearchWorkspaceResult>;
	start(input: StartResearchWorkspace): Promise<StartResearchWorkspaceResult>;
	confirm(input: ConfirmResearchWorkspace): Promise<ConfirmResearchWorkspaceResult>;
	appendTurn(input: AppendResearchTurn): Promise<AppendResearchTurnResult>;
	linkJob(input: LinkResearchTurnJob): Promise<LinkResearchTurnJobResult>;
	appendAgentMessage(
		input: AppendResearchAgentMessage,
	): Promise<AppendResearchAgentMessageResult>;
	publishInitialReport(
		input: PublishInitialResearchReport,
	): Promise<PublishInitialResearchReportResult>;
	list(channelId: string, limit: number): Promise<ResearchWorkspaceSummary[]>;
	listRepository(
		repositoryId: string,
		limit: number,
		includeArchived?: boolean,
	): Promise<ResearchWorkspaceRepositoryList>;
	get(channelId: string, workspaceId: string): Promise<ResearchWorkspaceDetail | undefined>;
	findTurnByJob(channelId: string, jobId: string): Promise<ResearchTurn | undefined>;
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
	readonly research: ResearchWorkspaceStore;

	migrate(): Promise<void>;
	health(): Promise<void>;
	close(): Promise<void>;
}
