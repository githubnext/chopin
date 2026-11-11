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
	ChannelDecisionCount,
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
	CreateMachine,
	CreateResearchWorkspace,
	CreateResearchWorkspaceResult,
	CreateWebSession,
	DecisionAnswer,
	DeferredTurn,
	DeferredTurnOutcome,
	DeferredTurnState,
	DeferredTurnTransition,
	DocumentVersion,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	Lease,
	LeasePeek,
	LinkResearchTurnJob,
	LinkResearchTurnJobResult,
	MachineChoice,
	MachineCredentials,
	MachineFavorite,
	MachineRepository,
	McpSession,
	NewDeferredTurn,
	PauseBackgroundJob,
	PlannerCredential,
	PlannerLinkHold,
	PlannerModelChoice,
	PublishChannelDescription,
	PublishChannelDescriptionResult,
	PublishInitialResearchReport,
	PublishInitialResearchReportResult,
	PutChatAttachment,
	PutImage,
	PutRunStages,
	PutUser,
	RecordDocumentVersion,
	RecordNavigationVisit,
	RenameChannel,
	RenameResult,
	RenewBackgroundJob,
	ReplaceChannel,
	RequeueBackgroundJob,
	ResearchTerminalRecovery,
	ResearchTurn,
	ResearchWorkspace,
	ResearchWorkspaceDetail,
	ResearchWorkspaceRepositoryList,
	ResearchWorkspaceSummary,
	ResetInitialResearchAttempt,
	ResetInitialResearchAttemptResult,
	ResumeBackgroundJob,
	RunStageRecord,
	SaveCheckpoint,
	SaveDecisionAnswer,
	SessionCredentials,
	SettleBackgroundJob,
	StagedChatAttachments,
	StartResearchWorkspace,
	StartResearchWorkspaceResult,
	StoredChannel,
	StoredChatAttachment,
	StoredDocumentVersion,
	StoredImage,
	StoredMachine,
	StoredPlannerLinkHold,
	StoredWebSession,
	SummarizeDocumentVersion,
	SupersedeBackgroundJob,
	UpdateAgentContext,
	UserNavigation,
	UserNavigationSnapshot,
	UserProject,
	UserRecord,
} from "./model";
import type { ExperimentStore } from "./experiments";

export interface UserStore {
	put(user: PutUser): Promise<UserRecord>;
	get(id: string): Promise<UserRecord | undefined>;
	/**
	 * The user each login names, in one read, compared case-insensitively as GitHub's logins are;
	 * a login nobody signed in under is left out. A login a person has given up stays on their row
	 * until they sign in again, so where two rows carry it the one saved last owns it.
	 */
	byLogins(logins: readonly string[]): Promise<UserRecord[]>;
}

export interface SessionStore {
	create(session: CreateWebSession): Promise<void>;
	get(id: string, now: Date): Promise<StoredWebSession | undefined>;
	rotate(id: string, expectedRevision: number, credentials: SessionCredentials): Promise<boolean>;
	delete(id: string): Promise<boolean>;
	deleteExpired(now: Date): Promise<number>;
	/**
	 * Release all Planner owners; retain only unexpired sessions with encrypted credentials. A
	 * document whose persisted Planner hold names a retained session keeps that owner.
	 */
	reset(
		now: Date,
		lease: Lease,
		leaseTtlMs: number,
	): Promise<{ deleted: number; lease: Lease }>;
}

/** Paired local agents. Credentials rotate by revision and never outlive revocation. */
export interface MachineStore {
	create(machine: CreateMachine): Promise<void>;
	get(id: string): Promise<StoredMachine | undefined>;
	/** Revoked machines are returned too, so callers can tell revocation apart. */
	byToken(tokenHash: Uint8Array): Promise<StoredMachine | undefined>;
	/** An owner's unrevoked machines, most recently paired first. */
	list(userId: string): Promise<StoredMachine[]>;
	/** Every unrevoked machine its owner shares with teammates, most recently paired first. */
	shared(): Promise<StoredMachine[]>;
	seen(id: string, now: Date): Promise<void>;
	rotate(id: string, expectedRevision: number, credentials: MachineCredentials): Promise<boolean>;
	/** Drop credentials GitHub refused at `expectedRevision`; the owner must pair again. */
	reauthorize(id: string, expectedRevision: number, now: Date): Promise<boolean>;
	/** True only for the call that revoked the owner's live machine. */
	revoke(id: string, userId: string, now: Date): Promise<boolean>;
	/** Rename the owner's live machine; false for anyone else's, or a revoked one. */
	rename(id: string, userId: string, label: string): Promise<boolean>;
	/** Add a repository the machine connected a checkout of, unless it already serves it. */
	serve(id: string, repository: MachineRepository): Promise<void>;
	/** The owner shares one of their machines with teammates, or stops; false when it isn't theirs. */
	share(id: string, userId: string, shared: boolean): Promise<boolean>;
	/** Every choice of an unrevoked machine. Revoking a machine forgets its choices. */
	choices(): Promise<MachineChoice[]>;
	/** Set one person's machine for one document, or without `machineId` go back to automatic. */
	choose(
		choice: Omit<MachineChoice, "machineId"> & { machineId?: string },
		now: Date,
	): Promise<void>;
	/**
	 * Every person's favorite unrevoked machine. Revoking a machine forgets it as a favorite, and
	 * its owner no longer sharing it forgets teammates' (not its owner's own).
	 */
	favorites(): Promise<MachineFavorite[]>;
	/**
	 * Set a person's favorite to one of their own machines or a teammate's that its owner shares,
	 * or without `machineId` clear it.
	 */
	favor(
		favorite: Omit<MachineFavorite, "machineId"> & { machineId?: string },
		now: Date,
	): Promise<void>;
}

export interface ImageStore {
	/** Idempotent: repeating an upload of the same bytes to a document keeps the first. */
	put(image: PutImage): Promise<void>;
	get(channelId: string, sha256: string): Promise<StoredImage | undefined>;
	/** Every document these bytes were uploaded to, oldest upload first. */
	channels(sha256: string): Promise<string[]>;
}

/** The images and text files people send with Chat messages, kept with the document. */
export interface ChatAttachmentStore {
	/** Keeps an upload as its uploader's own. Refuses a document or user that does not exist. */
	put(attachment: PutChatAttachment): Promise<void>;
	get(channelId: string, id: string): Promise<StoredChatAttachment | undefined>;
	/** What `userId` has uploaded to the document and not sent, to bound what one person can keep. */
	staged(channelId: string, userId: string): Promise<StagedChatAttachments>;
	/**
	 * Sends the uploads with the message `entryId`, in this order, all or none: it holds only when
	 * every id is an upload of `userId` to this document that is still unsent, or already sent
	 * with this same message (so a retried send binds again). Anything else binds nothing.
	 */
	bind(
		input: { channelId: string; userId: string; ids: string[]; entryId: string },
	): Promise<boolean>;
	/** The files of one message in the order they were sent, bytes included. */
	forEntry(channelId: string, entryId: string): Promise<StoredChatAttachment[]>;
	/** Takes back an upload its uploader has not sent. False when it is not theirs or was sent. */
	discard(channelId: string, id: string, userId: string): Promise<boolean>;
	/** Forgets what a deleted message carried. */
	discardEntry(channelId: string, entryId: string): Promise<number>;
	/** Forgets uploads nobody sent that are older than `before`; how many it forgot. */
	prune(before: Date): Promise<number>;
}

/**
 * Every stage of each workflow run a document's Chat shows, in the order the run first reported
 * them. Bounded per stage, not per run.
 */
export interface RunStageStore {
	/**
	 * Adds stages by id: a known one is replaced whole where it stands, a new one follows the
	 * run's others in input order; a repeated id keeps its last value. With `replace` the run keeps
	 * exactly these. Returns how many stages the run then has.
	 */
	put(input: PutRunStages): Promise<number>;
	/** The run's stages from `offset`, at most `limit`, and how many it has. */
	list(
		channelId: string,
		runId: string,
		page: { offset: number; limit: number },
	): Promise<{ stages: RunStageRecord[]; total: number }>;
	/** Forgets the stages of every run in the document but these. */
	retain(channelId: string, runIds: string[]): Promise<void>;
}

/**
 * Saved answers to decisions the Planner left open, one row per document and decision, waiting
 * for one Planner turn to carry them. A delivered row stays marked, so it never runs twice.
 */
export interface DecisionAnswerStore {
	/**
	 * Keeps a decision's newest saved generation: a newer one replaces a waiting, claimed or
	 * delivered row and waits afresh; the same or an older one changes nothing.
	 */
	save(input: SaveDecisionAnswer): Promise<void>;
	/** The document's undelivered answers, oldest saved first. */
	pending(channelId: string): Promise<DecisionAnswer[]>;
	/**
	 * Names the turn that carries these answers, each only while still undelivered, unclaimed and
	 * at that generation. Returns how many it claimed.
	 */
	claim(
		channelId: string,
		turnId: string,
		answers: Array<{ decisionId: string; generation: number }>,
	): Promise<number>;
	/** Returns a turn that never started to waiting, for the next one. */
	release(channelId: string, turnId: string): Promise<void>;
	/** Marks the turn's answers delivered. */
	delivered(channelId: string, turnId: string, at: Date): Promise<void>;
}

/** A document's editing sessions, newest first. History is derived; nothing replays it. */
export interface DocumentVersionStore {
	/** Extend the latest session when it is the same author's and recent, otherwise start one. */
	record(input: RecordDocumentVersion): Promise<DocumentVersion | undefined>;
	list(channelId: string, limit: number): Promise<DocumentVersion[]>;
	get(channelId: string, id: string): Promise<StoredDocumentVersion | undefined>;
	/** The session before `id`, whose source a summary of `id` compares against. */
	previous(channelId: string, id: string): Promise<StoredDocumentVersion | undefined>;
	/** Stores a summary when the session still has that source; reports whether it did. */
	summarize(input: SummarizeDocumentVersion): Promise<boolean>;
}

export interface NavigationStore {
	snapshot(userId: string): Promise<UserNavigationSnapshot>;
	projects(userId: string): Promise<UserProject[]>;
	firstDocument(userId: string, repositoryIds: string[]): Promise<string | undefined>;
	addProject(input: AddUserProject): Promise<AddUserProjectResult>;
	/**
	 * Takes a repository out of a person's projects; false when it wasn't one. Their last
	 * document is forgotten when it is in that repository. Visiting one of its documents adds
	 * the project again.
	 */
	removeProject(userId: string, repositoryId: string, now: Date): Promise<boolean>;
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
	/** Unarchived direct children of one channel, oldest first, at most `limit`. */
	children(parentId: string, limit: number): Promise<ChannelRecord[]>;
	resolve(repositoryId: string, slug: string): Promise<ChannelRecord | undefined>;
	/** Slugs a document had before a rename, which still resolve to it, newest first by first use. */
	earlierSlugs(id: string): Promise<string[]>;
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
	/** Totals the repository's active catalogue: what `list` returns without archived rows. */
	unansweredDecisions(repositoryId: string): Promise<number>;
	/** Current counts for the requested channels that belong to the repository, archived or not. */
	unansweredDecisionCounts(
		repositoryId: string,
		channelIds: string[],
	): Promise<ChannelDecisionCount[]>;
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
	/**
	 * Clear stored conversation state from every child channel. Fenced by the writer
	 * lease, run at startup before any room opens, and idempotent. A child whose
	 * decision records cite its Chat is kept unchanged and reported.
	 */
	dropChildConversations(lease: Lease): Promise<{ cleared: string[]; kept: string[] }>;
}

export interface LeaseStore {
	/**
	 * Reads a lease with a plain query: it takes no lock, so it never waits for the holder's writes
	 * or delays them. Undefined when the lease was never taken.
	 */
	peek(name: string): Promise<LeasePeek | undefined>;
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
	markReferencePlaced(input: {
		channelId: string;
		workspaceId: string;
		lease: Lease;
	}): Promise<void>;
	listReferenceRecovery(
		limit: number,
		afterId?: string,
		channelId?: string,
	): Promise<ResearchWorkspace[]>;
	listTerminalRecovery(
		limit: number,
		afterId?: string,
		channelId?: string,
	): Promise<ResearchTerminalRecovery[]>;
	confirm(input: ConfirmResearchWorkspace): Promise<ConfirmResearchWorkspaceResult>;
	appendTurn(input: AppendResearchTurn): Promise<AppendResearchTurnResult>;
	linkJob(input: LinkResearchTurnJob): Promise<LinkResearchTurnJobResult>;
	resetInitialAttempt(
		input: ResetInitialResearchAttempt,
	): Promise<ResetInitialResearchAttemptResult>;
	appendAgentMessage(
		input: AppendResearchAgentMessage,
	): Promise<AppendResearchAgentMessageResult>;
	publishInitialReport(
		input: PublishInitialResearchReport,
	): Promise<PublishInitialResearchReportResult>;
	list(
		channelId: string,
		limit: number,
		includePlanner?: boolean,
	): Promise<ResearchWorkspaceSummary[]>;
	listRepository(
		repositoryId: string,
		limit: number,
		includeArchived?: boolean,
		includePlanner?: boolean,
	): Promise<ResearchWorkspaceRepositoryList>;
	get(channelId: string, workspaceId: string): Promise<ResearchWorkspaceDetail | undefined>;
	findByIdempotencyKey(
		channelId: string,
		idempotencyKey: string,
	): Promise<ResearchWorkspaceDetail | undefined>;
	/** The workspace in `channelId` whose report became the child document `publishedChannelId`. */
	findPublished(
		channelId: string,
		publishedChannelId: string,
	): Promise<ResearchWorkspaceDetail | undefined>;
	findTurnByJob(channelId: string, jobId: string): Promise<ResearchTurn | undefined>;
}

/**
 * Each document's remote Planner as its link left it, one row per document, so the process that
 * takes over can rebuild it. Writes are fenced by the writer lease. A hold goes with its owner's
 * login session and with its document; everything else that ends one deletes it.
 */
export interface PlannerLinkHoldStore {
	/** Replaces the document's hold, recording the lease's fencing token. */
	put(lease: Lease, hold: PlannerLinkHold): Promise<void>;
	/** True only for the call that removed a hold. */
	delete(lease: Lease, channelId: string): Promise<boolean>;
	get(channelId: string): Promise<StoredPlannerLinkHold | undefined>;
	/** Every hold, by document id. */
	list(): Promise<StoredPlannerLinkHold[]>;
}

/**
 * The model and thinking level chosen for each document's Planner. Writes are fenced by the writer
 * lease; a row goes with its document.
 */
export interface PlannerModelChoiceStore {
	/** Replaces the document's choice whole. A choice with neither field removes the row. */
	put(lease: Lease, choice: PlannerModelChoice): Promise<void>;
	get(channelId: string): Promise<PlannerModelChoice | undefined>;
}

/**
 * Credentials a paired machine hands to a Planner backend, by digest. A row is written before
 * its credential is handed out, so a process that starts later accepts it while it lasts.
 */
export interface PlannerCredentialStore {
	/** Throws a conflict for a digest already stored. */
	put(credential: PlannerCredential): Promise<void>;
	/** The credential for this digest while it has not expired at `now`. */
	find(digest: Uint8Array, now: Date): Promise<PlannerCredential | undefined>;
	delete(digest: Uint8Array): Promise<boolean>;
	/** One machine's credentials, for one document or for every document; returns how many. */
	deleteForMachine(machineId: string, channelId?: string): Promise<number>;
	deleteExpired(now: Date): Promise<number>;
}

/** MCP sessions, which a restart no longer ends. Idle ones are swept. */
export interface McpSessionStore {
	/** Idempotent: an id already stored keeps its first record. */
	create(session: McpSession): Promise<void>;
	find(id: string): Promise<McpSession | undefined>;
	/** Records activity; false for an unknown session. Never moves `lastSeenAt` back. */
	touch(id: string, now: Date): Promise<boolean>;
	/** Forgets sessions not seen since `before`; returns how many. */
	deleteIdle(before: Date): Promise<number>;
}

/**
 * Acknowledged Planner requests whose turn has not started, one row each. Every write is fenced
 * by the writer lease and conditional on the row's state; a write that does not apply changes
 * nothing and says why. The same changes can ride a `collaboration.commit`, which is how a row
 * is made durable no later than the entry that acknowledges it.
 */
export interface DeferredTurnStore {
	/**
	 * Adds a `waiting` row. A request id the document already has returns that row, and a comment
	 * thread that already has a waiting row returns it, writing nothing.
	 */
	insert(lease: Lease, turn: NewDeferredTurn): Promise<DeferredTurnOutcome>;
	/**
	 * Moves a row from the state it is expected to be in, recording the lease's fencing token and,
	 * for a final state, `at`. A turn ends only under the lease it started under.
	 */
	transition(lease: Lease, change: DeferredTurnTransition): Promise<DeferredTurnOutcome>;
	/**
	 * Marks every `started` row written under an older fencing token interrupted, in a document or
	 * in all, and returns them in the order they were accepted. Fencing tokens compare only within
	 * one lease: the deployment's writer lease, which every row is written under.
	 */
	interruptStale(lease: Lease, at: Date, documentId?: string): Promise<DeferredTurn[]>;
	get(documentId: string, requestId: string): Promise<DeferredTurn | undefined>;
	/** A document's rows in the order they were accepted, optionally only in these states. */
	list(documentId: string, states?: DeferredTurnState[]): Promise<DeferredTurn[]>;
	/** Documents with a row in any of these states, by id. */
	documents(states: DeferredTurnState[]): Promise<string[]>;
}

/** The complete durable boundary. No provider-specific primitive crosses it. */
export interface StorageAdapter {
	readonly experiments: ExperimentStore;
	readonly driver: string;
	readonly users: UserStore;
	readonly sessions: SessionStore;
	readonly navigation: NavigationStore;
	readonly channels: ChannelStore;
	readonly collaboration: CollaborationStore;
	readonly leases: LeaseStore;
	readonly jobs: BackgroundJobStore;
	readonly research: ResearchWorkspaceStore;
	readonly images: ImageStore;
	readonly chatAttachments: ChatAttachmentStore;
	readonly runStages: RunStageStore;
	readonly decisionAnswers: DecisionAnswerStore;
	readonly versions: DocumentVersionStore;
	readonly machines: MachineStore;
	readonly plannerHolds: PlannerLinkHoldStore;
	readonly plannerModelChoices: PlannerModelChoiceStore;
	readonly plannerCredentials: PlannerCredentialStore;
	readonly mcpSessions: McpSessionStore;
	readonly deferredTurns: DeferredTurnStore;

	migrate(): Promise<void>;
	health(): Promise<void>;
	close(): Promise<void>;
}
