import { Cell } from "@mdxeditor/gurx";

import type { ChangeStore } from "./changes";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type CommentPresentation = "popover" | "sheet";

export type WidgetOptions = {
	commentPresentation?: CommentPresentation;
	motionImmediately?: () => boolean;
	questions?: QuestionnaireStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	canEdit?: boolean;
};

export const widgets$ = Cell<WidgetOptions>({});
