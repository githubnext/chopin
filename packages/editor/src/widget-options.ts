import { Cell } from "@mdxeditor/gurx";

import type { ResearchLauncher } from "./research-launcher";
import type { PublishedInvestigation } from "@chopin/experiment/records";
import type { SelectionPatch } from "@chopin/experiment";
import type { ReactNode } from "react";
import type { CardMetaStore } from "./card-meta";
import type { Binding } from "@lexical/yjs";
import type { ChangeStore } from "./changes";
import type { ContentSwapMotion } from "./content-swap";
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
	/** False when no Planner will review where decisions live. */
	planner?: boolean;
	evidence?: (questionnaireId: string) => ReactNode | null;
	research?: ResearchStore;
	researchDrafts?: ResearchDraftStore;
	researchLauncher?: ResearchLauncher;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	synced?: boolean;
	canEdit?: boolean;
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
};

export const widgets$ = Cell<WidgetOptions>({});
