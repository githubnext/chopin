import { Cell } from "@mdxeditor/gurx";

import type { Binding } from "@lexical/yjs";
import type { ChangeStore } from "./changes";
import type { ContentSwapMotion } from "./content-swap";
import type { Research } from "@chopin/protocol";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type CommentPresentation = "popover" | "sheet";

export type QuestionStepMotion = {
	contract: ContentSwapMotion;
	immediately: () => boolean;
};

/** App-owned HTTP state and actions for durable Research Workspace references. */
export type ResearchStore = {
	subscribe(listener: () => void): () => void;
	get(id: string): Research.RequestView | undefined;
	refresh(id: string): void;
	create(question: string, requestId: string): Promise<Research.RequestView>;
	cancel(id: string): Promise<Research.RequestView>;
	retry(id: string, question: string): Promise<Research.RequestView>;
	open(child: Research.ReadyChild): void;
};

export type WidgetOptions = {
	binding?: Binding;
	commentPresentation?: CommentPresentation;
	motionImmediately?: () => boolean;
	questionMotion?: QuestionStepMotion;
	questions?: QuestionnaireStore;
	research?: ResearchStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	canEdit?: boolean;
};

export const widgets$ = Cell<WidgetOptions>({});
