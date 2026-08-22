import { Cell } from "@mdxeditor/gurx";

import type { ChangeStore } from "./changes";
import type { JobStore } from "./jobs";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type CommentPresentation = "popover" | "sheet";

export type WidgetOptions = {
	commentPresentation?: CommentPresentation;
	questions?: QuestionnaireStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
	canEdit?: boolean;
	jobs?: JobStore;
};

export const widgets$ = Cell<WidgetOptions>({});
