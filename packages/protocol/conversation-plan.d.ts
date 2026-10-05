import type { Chat } from "./chat";
import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/** The prototype's sidecar and wire contract. Accepted events are its domain authority. */
export declare namespace ConversationPlan {
	export type Incoming =
		| Request<Correct>
		| Request<SaveScopedChoice>
		| Request<Retry>
		| Request<RetryJob>
		| Request<ResearchConsent>
		| Request<ResearchEdit>
		| Request<ResearchPresence>
		| Request<ResearchLink>;
	export type Outgoing =
		| Snapshot
		| Changed
		| Corrected
		| SavedScopedChoice
		| Retried
		| Jobs
		| RetriedJob
		| ResearchConsentResult
		| ResearchEdited
		| ResearchPresenceChanged
		| ResearchLinkResult;

	export type JobKind = "heading" | "refine" | "suggest" | "prose";
	/** One durable piece of background Planner work. */
	export type Job = {
		id: string;
		kind: JobKind;
		/** Questionnaire id, or "document" for a heading job. */
		target: string;
		/** Chat message or decision that caused this job. */
		trigger: string;
		status: "pending" | "running" | "done" | "failed" | "skipped";
		attempts: number;
		reason?: string;
		/** Short JSON summary of the tool result. */
		output?: string;
		/** ISO 8601 time of the last status change. */
		at: string;
	};

	export type SourceAuthor = Extract<Chat.Author, { kind: "member" | "agent" }>;
	export type Actor = SourceAuthor | { kind: "classifier" };
	/** A withdrawal source supports only a neutral stance that retracts its speaker's pending choice. */
	export type SourceRole =
		| "question"
		| "option"
		| "reason"
		| "constraint"
		| "support"
		| "objection"
		| "withdrawal"
		| "verification"
		| "resolution"
		| "reopening";

	/** UTF-16 offsets into a saved, complete Chat entry. */
	export type SourceRef = {
		messageId: string;
		author: SourceAuthor;
		quote: string;
		start: number;
		end: number;
		role: SourceRole;
	};
	/** Exact source span for a Research offer, without a classifier contribution role. */
	export type ResearchSource = Omit<SourceRef, "role">;
	export type ResearchAction = {
		id: string;
		kind: "research" | "dismiss";
		/** Supplied by the authorized caller, not by the classifier or client payload. */
		actor: Extract<Chat.Author, { kind: "member" }>;
		/** Stable verified GitHub user ID for an idempotent research request. */
		principalId: string;
		at: number;
	};
	/** Frozen option wording and event prefix for one bounded current-cost task. */
	export type ResearchTask =
		| {
			kind: "current-cost-comparison";
			threadId: string;
			/** Exact accepted-event prefix and thread version when these labels were captured. */
			observedEventCount: number;
			observedThreadVersion: number;
			options: [{ id: string; labelAtOffer: string }, { id: string; labelAtOffer: string }];
		}
		| {
			kind: "current-cost-concern";
			threadId: string;
			observedEventCount: number;
			observedThreadVersion: number;
			/** Every current option, in thread order; no pair is inferred from the concern. */
			options:
				| [{ id: string; labelAtOffer: string }, { id: string; labelAtOffer: string }, {
					id: string;
					labelAtOffer: string;
				}]
				| [{ id: string; labelAtOffer: string }, { id: string; labelAtOffer: string }, {
					id: string;
					labelAtOffer: string;
				}, { id: string; labelAtOffer: string }];
			/** Only a unique option named by the exact source quote may be focused. */
			focusOptionId?: string;
		};
	export type ResearchOffer = {
		id: string;
		/** Opaque semantic identity; needId with contextId suppresses repeat offers. */
		needId: string;
		contextId: string;
		source: ResearchSource;
		/** Absent on earlier offers, whose brief is the exact source quote. */
		task?: ResearchTask;
		/** Deterministic public-worker brief and displayed wording. */
		brief: string;
		threadId?: string;
		status: "offered" | "dismissed" | "accepted";
		action?: ResearchAction;
		/** General research offers; absent on persisted pricing-only offers. */
		workflow?: ResearchWorkflow;
	};
	export type ResearchContext = {
		messages: Array<{ id: string; author: SourceAuthor; text: string }>;
		decisions: Array<{
			id: string;
			version: number;
			question: string;
			options: Array<{ id: string; label: string }>;
			answer?: string;
		}>;
	};
	export type ResearchAddition = {
		id: string;
		text: string;
		sources: ResearchSource[];
		status: "pending" | "applied" | "dismissed";
		actionId?: string;
		actor?: string;
	};
	export type ResearchWorkflow = {
		version: 1;
		revision: number;
		generation: number;
		mode: "automatic" | "human";
		/** Presentation only; never participates in request identity. */
		placementMessageId: string;
		sources: ResearchSource[];
		context: ResearchContext;
		published: boolean;
		preparation: "pending" | "ready" | "failed";
		jobId?: string;
		modelVersion?: string;
		/** Complete, validated string CRDT checkpoint. */
		draft?: number[];
		editedBy: string[];
		additions: ResearchAddition[];
		previousOfferId?: string;
		accepted?: { brief: string; revision: number; executionKey: string };
	};
	export type ResearchAnalysis = {
		messageId: string;
		questionSetVersion: string;
		modelVersion: string;
		status: "applied" | "unlinked" | "failed";
		answers: Record<string, AnalysisAnswer>;
		policyGate: string;
		offerId?: string;
		latencyMs: number;
	};
	export type ResearchState = {
		queue: QueueItem[];
		analysis: ResearchAnalysis[];
		/** Retry receipts survive pruning of diagnostic history. */
		retries: Array<{ id: string; messageId: string }>;
	};

	export type Authoring = "quoted" | "scribe" | "human-edited";
	export type ThreadStatus = "exploring" | "leaning" | "decided" | "reopened" | "discarded";
	export type Contribution = {
		id: string;
		kind: "option" | "reason" | "constraint";
		text: string;
		/** Concise card wording; text and sources remain the original evidence. */
		displayLabel?: string;
		targetId?: string;
		relation?: "supports" | "challenges" | "qualifies";
		authoring: Authoring;
		editedBy?: string;
		targetEditedBy?: string;
		sources: SourceRef[];
		actor: Actor;
	};
	export type Stance = {
		id: string;
		participant: string;
		optionId?: string;
		position: "support" | "oppose" | "neutral";
		sources: SourceRef[];
		at: number;
		corrects?: string;
		correctedBy?: string;
	};
	export type Decision = {
		id: string;
		text: string;
		optionId?: string;
		sources: SourceRef[];
		actor: Extract<Chat.Author, { kind: "member" }>;
		editedBy?: string;
		at: number;
	};
	export type Candidate = {
		id: string;
		kind: "resolution" | "reopening";
		text: string;
		sources: SourceRef[];
		status: "pending" | "confirmed" | "rejected";
		actedBy?: string;
	};
	export type Thread = {
		id: string;
		question: string;
		questionSources: SourceRef[];
		questionAuthoring: Authoring;
		questionEditedBy?: string;
		status: ThreadStatus;
		contributions: Contribution[];
		/** Latest explicit stance for each participant and option. */
		stances: Stance[];
		stanceHistory: Stance[];
		decision?: Decision;
		decisionHistory: Decision[];
		candidates: Candidate[];
		/** The decision card that shows this thread in the document. */
		questionnaireId?: string;
		/** The latest proposal to settle, until a person decides or it is superseded. */
		pendingSettle?: { optionId: string; proposer: string; messageId: string };
		/** A provisional choice for a spike; this never decides the card. */
		pendingScopedChoice?: {
			/** Absent only on snapshots written before scoped agreements existed. */
			proposalId?: string;
			cardId: string;
			optionId: string;
			label: string;
			scope: "spike";
			proposer: string;
			messageId: string;
		};
		version: number;
	};

	export type EventBase = {
		id: string;
		threadId: string;
		observedThreadVersion: number;
		origin: "classifier" | "planner" | "human";
		actor: Actor;
		at: number;
	};
	export type ScopedChoiceSave = {
		actionId: string;
		threadId: string;
		expectedVersion: number;
		proposalId: string;
		cardId: string;
		optionId: string;
		expectedLabel?: string;
		expectedGeneration: number;
	};
	export type Event =
		| (EventBase & { type: "thread.opened"; source?: SourceRef; question: string })
		| (EventBase & {
			type: "option.added" | "reason.added" | "constraint.added";
			/** Required for sourced chat inference; absent for human and Planner card actions. */
			source?: SourceRef;
			contribution: Pick<Contribution, "id" | "text" | "authoring" | "targetId" | "relation">;
		})
		| (EventBase & {
			type: "stance.changed";
			source: SourceRef;
			optionId?: string;
			/** Null means reviewed without a scoped target; absent only on persisted legacy events. */
			scopedProposalId?: string | null;
			position: Stance["position"];
		})
		| (EventBase & {
			type: "option.relabeled";
			optionId: string;
			label: string;
			observedCardRevision: number;
		})
		| (EventBase & { type: "thread.leaning"; source: SourceRef; optionId?: string })
		| (EventBase & { type: "card.linked"; questionnaireId: string })
		| (EventBase & { type: "settle.suggested"; source: SourceRef; optionId: string })
		| (EventBase & { type: "settle.agreed"; source: SourceRef; optionId: string })
		| (EventBase & { type: "settle.deferred"; source: SourceRef; proposalId: string })
		| (EventBase & {
			type: "settle.resumed";
			source: SourceRef;
			proposalId: string;
			deferredEventId: string;
		})
		| (EventBase & {
			type: "scoped-choice.proposed";
			source: SourceRef;
			cardId: string;
			optionId: string;
			label: string;
			scope: "spike";
		})
		| (EventBase & {
			type: "scoped-choice.agreed";
			source: SourceRef;
			proposalId: string;
			cardId: string;
			optionId: string;
			label: string;
			scope: "spike";
		})
		| (EventBase & {
			type: "scoped-choice.saved";
			proposalId: string;
			/** New saves bind each current support source to its accepted proposal or agreement event. */
			supportEventIds?: string[];
			/** Present on legacy proposal-plus-one-agreement saves. */
			agreementId?: string;
			cardId: string;
			optionId: string;
			label: string;
			scope: "spike";
			sources: SourceRef[];
			expectedGeneration: number;
			expectedLabel?: string;
		})
		| (EventBase & { type: "thread.discarded" })
		| (EventBase & {
			type: "decision.recorded";
			source?: SourceRef;
			text: string;
			optionId?: string;
			explicit: true;
		})
		| (EventBase & { type: "decision.reopened"; source?: SourceRef; explicit: true })
		| (EventBase & {
			type: "candidate.proposed";
			source: SourceRef;
			candidate: Pick<Candidate, "id" | "kind" | "text">;
		})
		| (EventBase & {
			type: "candidate.confirmed" | "candidate.rejected";
			candidateId: string;
		})
		| (EventBase & {
			type: "card.corrected";
			change: EditChange | MoveChange | StatusChange | RetargetChange;
		});

	export type EditChange =
		| { kind: "edit"; field: "question" | "decision"; text: string; contributionId?: never }
		| { kind: "edit"; field: "contribution"; text: string; contributionId: string };
	export type MoveChange = {
		kind: "move";
		contributionId: string;
		targetThreadId: string;
		targetVersion: number;
	};
	export type StatusChange = {
		kind: "set-status";
		status: Exclude<ThreadStatus, "decided" | "discarded">;
	};
	export type RetargetChange =
		| { kind: "retarget-stance"; stanceId: string; optionId?: string }
		| { kind: "dismiss-stance"; stanceId: string }
		| { kind: "retarget-contribution"; contributionId: string; targetId: string };
	export type CorrectionChange =
		| EditChange
		| MoveChange
		| StatusChange
		| RetargetChange
		| {
			kind: "add-excerpt";
			messageId: string;
			start: number;
			end: number;
			contributionKind: "option" | "reason" | "constraint";
			targetOptionId?: string;
		}
		| { kind: "record-decision"; text: string; optionId?: string }
		| { kind: "confirm-candidate" | "reject-candidate"; candidateId: string };
	export type CorrectionAction = {
		/** Stable across client retries, independent of the request's rid. */
		actionId: string;
		threadId: string;
		expectedVersion: number;
		change: CorrectionChange;
	};

	export type QueueItem = {
		messageId: string;
		status: "pending" | "processing" | "failed";
		attempts: number;
		error?: string;
	};
	export type Distribution = { [answer: string]: number };
	export type AnalysisAnswer =
		| { type: "noul"; noul: number }
		| { type: "choice"; choice: string; confidence: number; probabilities: Distribution }
		| {
			type: "score";
			score: number;
			confidence: number;
			legend: { [level: string]: string };
			probabilities: Distribution;
		};
	export type AnalysisPass =
		| { stage: "triage" | "targeting"; answers: { [question: string]: AnalysisAnswer } }
		| {
			stage: "clarification";
			version: "bare-editor-clarification-1";
			answers: { [question: string]: AnalysisAnswer };
		};
	export type CandidateOutcome = {
		start: number;
		end: number;
		status: "accepted" | "review" | "ignored";
		gate: string;
		targetId?: string;
		eventIds: string[];
	};
	export type AnalysisRecord = {
		messageId: string;
		questionSetVersion: string;
		modelVersion: string;
		status: "queued" | "running" | "applied" | "unlinked" | "failed";
		passes: AnalysisPass[];
		selectedTarget?: string;
		quoteValidation?: Array<{ start: number; end: number; valid: boolean }>;
		outcomes?: CandidateOutcome[];
		policyGate?: string;
		candidates?: Array<{ id: string; kind: Candidate["kind"]; targetId?: string }>;
		eventIds: string[];
		latencyMs?: number;
		error?: string;
	};
	export type State = {
		schemaVersion: 1 | 2;
		revision: number;
		events: Event[];
		threads: Thread[];
		queue: QueueItem[];
		/** Bounded diagnostics; accepted event IDs remain in events. */
		analysis: AnalysisRecord[];
		/** Optional for version-1 sidecars saved before research offers existed. */
		researchOffers?: ResearchOffer[];
		/** Required in version two; version one is upgraded on restoration. */
		research?: ResearchState;
	};

	export type Correct = KIND<"conversation-plan:correct"> & CorrectionAction;
	export type SaveScopedChoice = KIND<"conversation-plan:scoped-choice-save"> & ScopedChoiceSave;
	export type Retry = KIND<"conversation-plan:retry"> & {
		actionId: string;
		messageId: string;
		lane?: "decision" | "research";
	};
	export type ResearchConsent =
		& KIND<"conversation-plan:research">
		& (
			| { offerId: string; actionId: string; choice: "research" | "dismiss" }
			| { offerId: string; choice: "resume"; actionId?: never }
		);
	export type ResearchConsentResult = KIND<"conversation-plan:research"> & {
		offerId: string;
		status: ResearchOffer["status"];
		revision: number;
		execution: "none" | "pending-owner" | "pending-retry" | "started";
		/** Present when this attempt returned an already placed research request. */
		researchRequestId?: string;
	};
	export type ResearchEdit = KIND<"conversation-plan:research-edit"> & {
		offerId: string;
		operation:
			| { kind: "begin" }
			| { kind: "patch"; patch: number[] }
			| { kind: "addition"; id: string; actionId: string; choice: "apply" | "dismiss" }
			| { kind: "retry" };
	};
	export type ResearchEdited = KIND<"conversation-plan:research-edit"> & {
		offer: ResearchOffer;
		revision: number;
	};
	export type ResearchPresence = KIND<"conversation-plan:research-presence"> & {
		offerId: string;
		editing: boolean;
	};
	export type ResearchPresenceChanged = KIND<"conversation-plan:research-presence"> & {
		offerId: string;
		client: string;
		handle: string;
		editing: boolean;
	};
	export type ResearchLink = KIND<"conversation-plan:research-link"> & { offerId: string };
	export type ResearchLinkResult = KIND<"conversation-plan:research-link"> & {
		offerId: string;
		status: "pending" | "unlinked" | "linked";
		/** Present for an existing exact request, including before its first job is linked. */
		researchRequestId?: string;
	};
	export type Snapshot = KIND<"conversation-plan:snapshot"> & { state: State; jobs?: Job[] };
	export type Changed = KIND<"conversation-plan:changed"> & { state: State };
	export type Jobs = KIND<"conversation-plan:jobs"> & { jobs: Job[] };
	export type Corrected = KIND<"conversation-plan:correct"> & { eventId: string; revision: number };
	export type SavedScopedChoice = KIND<"conversation-plan:scoped-choice-save"> & {
		eventId: string;
		revision: number;
	};
	export type Retried = KIND<"conversation-plan:retry"> & { messageId: string; queued: boolean };
	export type RetryJob = KIND<"conversation-plan:retry-job"> & { jobId: string };
	export type RetriedJob = KIND<"conversation-plan:retry-job"> & {
		jobId: string;
		queued: boolean;
	};
}
