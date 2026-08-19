import { Cell } from "@mdxeditor/gurx";

import type { ChangeStore } from "./changes";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type WidgetOptions = {
	commentPresentation?: "popover" | "sheet";
	questions?: QuestionnaireStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
};

export const widgets$ = Cell<WidgetOptions>({});
