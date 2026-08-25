import { Cell } from "@mdxeditor/gurx";

import type { ChangeStore } from "./changes";
import type { ContentSwapMotion } from "./content-swap";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type CommentPresentation = "popover" | "sheet";

export type QuestionStepMotion = {
	contract: ContentSwapMotion;
	immediately: () => boolean;
};

export type WidgetOptions = {
	commentPresentation?: CommentPresentation;
	motionImmediately?: () => boolean;
	questionMotion?: QuestionStepMotion;
	questions?: QuestionnaireStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	canEdit?: boolean;
};

export const widgets$ = Cell<WidgetOptions>({});
