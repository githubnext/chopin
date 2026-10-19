import { Cell } from "@mdxeditor/gurx";

import type { ResearchLauncher } from "./research-launcher";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import type { SelectionPatch } from "@chopin/experiment";
import type { ReactNode } from "react";
import type { CardMetaStore } from "./card-meta";
import type { Binding } from "@lexical/yjs";
import type { ChangeStore } from "./changes";
import type { ContentSwapMotion } from "./content-swap";
import type { EditMode } from "./edit-mode";
import type { MotionDisclosureContract } from "./disclosure-motion";
import type { Research } from "@chopin/protocol";
import type { GitHubReference, GitHubReferenceResult } from "@chopin/protocol/github-reference";
import type { ResearchDraftStore } from "./research-draft";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type CommentPresentation = "popover" | "sheet";

export type QuestionStepMotion = {
	contract: ContentSwapMotion;
	immediately: () => boolean;
};

export type ResearchOpener = { readonly current: HTMLElement | null };

/** App-owned HTTP state and actions for durable Research Workspace references. */
export type ResearchStore = {
	subscribe(listener: () => void): () => void;
	retain(id: string): () => void;
	get(id: string): Research.RequestView | undefined;
	mutating(id: string): boolean;
	refresh(id: string): void;
	create(question: string, requestId: string): Promise<Research.RequestView>;
	cancel(id: string): Promise<Research.RequestView>;
	retry(id: string): Promise<Research.RequestView>;
	opener(id: string, current?: HTMLElement | null): ResearchOpener;
	open(child: Research.ReadyChild, opener: ResearchOpener): void;
};

/**
 * App-owned local investigations. The editor places an id-only reference and
 * leaves the card, its record, and its actions to the host.
 */
export type InvestigationResources = {
	create(brief: string, requestId: string): Promise<{ id: string }>;
	cancel(id: string): Promise<unknown>;
	/** False while the record still needs its card: unknown, queued, running or publishing. */
	removable(id: string): boolean;
	render(id: string, remove: () => void): ReactNode;
};

/** A GitHub reference's summary as the host last saw it, or that one is on its way. */
export type GitHubReferenceEntry = { status: "loading" } | GitHubReferenceResult;

/**
 * App-owned summaries for GitHub pull request and issue links.
 *
 * Reading is cheap and may happen on every editor update: `get` answers from
 * memory and asks the host to fetch (batched) when it has nothing or what it
 * has is stale, notifying subscribers when the answer changes.
 */
export type GitHubReferenceStore = {
	subscribe(listener: () => void): () => void;
	get(reference: GitHubReference): GitHubReferenceEntry;
	/** Settles with a fresh answer, for a paste that wants a title. */
	load(reference: GitHubReference): Promise<GitHubReferenceResult>;
};

/**
 * App-owned ways to explore an open decision. The editor records findings over the question
 * transport; the host starts the external work, which runs on the top-level document.
 */
export type ExploreResources = {
	/** Start web research from `brief`; resolves with the request's id. */
	research(brief: string, requestId: string): Promise<string>;
	/** Build a spike on the viewer's paired machine; `id` becomes the investigation's id. */
	spike(brief: string, id: string): Promise<void>;
	/** Why a spike cannot run now, or undefined when it can. */
	spikeUnavailable(): string | undefined;
	/** People the viewer can ask, excluding themselves. */
	people(): readonly string[];
	/** Open the decision as its own page; absent where it cannot have one. */
	openPage?(questionnaireId: string): void;
	subscribe(listener: () => void): () => void;
};

export type WidgetOptions = {
	experiments?: ExperimentResources;
	binding?: Binding;
	commentPresentation?: CommentPresentation;
	motionImmediately?: () => boolean;
	disclosureMotion?: MotionDisclosureContract;
	questionMotion?: QuestionStepMotion;
	questions?: QuestionnaireStore;
	cardMeta?: CardMetaStore;
	onCardSource?: (questionnaireId: string) => void;
	/** Whether a card has a Chat message to go back to. */
	hasCardSource?: (questionnaireId: string) => boolean;
	/** Open a decision in the Decisions pane; phones show open decisions there only. */
	onShowDecision?: (questionnaireId: string) => void;
	/** False when no Planner will review where decisions live. */
	planner?: boolean;
	/** False when no Planner can take a turn now, so a new comment is not sent to Chopin by default. */
	commentPlanner?: boolean;
	evidence?: (questionnaireId: string) => ReactNode | null;
	research?: ResearchStore;
	explore?: ExploreResources;
	researchDrafts?: ResearchDraftStore;
	investigations?: InvestigationResources;
	investigationDrafts?: ResearchDraftStore;
	researchLauncher?: ResearchLauncher;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	synced?: boolean;
	canEdit?: boolean;
	/** This client's reading or editing mode on a phone; see `edit-mode.ts`. */
	editMode?: EditMode;
	/** Locked for any reason other than reading mode, so a reader's selection can still comment. */
	blocked?: boolean;
	/** Where the host docks formatting while editing on a phone, replacing the selection bubble. */
	formatDock?: HTMLElement | null;
	/** Told while the dock's Insert or Text style panel holds the keyboard's place. */
	onFormatPanel?: (open: boolean) => void;
	/** The viewer's own handle. */
	self?: string;
};

export type ExperimentResources = {
	subscribe(listener: () => void): () => void;
	snapshot(): number;
	get(id: string): PublishedInvestigation | undefined;
	load(id: string): Promise<void>;
	change(id: string, view: string, patch: SelectionPatch): Promise<void>;
	place(id: string, view: string, decision?: string, remove?: boolean): Promise<void>;
	/** Host actions under a live view, such as recording a decision from it. */
	actions?(id: string, view: string): ReactNode;
};

export const widgets$ = Cell<WidgetOptions>({});
