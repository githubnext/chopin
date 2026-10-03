import { expect, test } from "bun:test";

import { cardPresentation } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

test.each(
	[
		[
			"open",
			{
				...DECIDED,
				questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
			},
			undefined,
			"inline",
			"open",
		],
		["discarded inline", DECIDED, { ...META, status: "discarded" as const }, "inline", "hidden"],
		[
			"discarded in the list",
			DECIDED,
			{ ...META, status: "discarded" as const },
			"list",
			"resolved",
		],
		["decided with prose", DECIDED, { ...META, hasProse: true }, "inline", "hidden"],
		["decided conversation card without prose", DECIDED, META, "inline", "settled-line"],
		[
			"decided Planner card without prose",
			DECIDED,
			{ ...META, origin: "planner" as const },
			"inline",
			"settled-line",
		],
		["decided with no meta yet", DECIDED, undefined, "inline", "settled-line"],
		["reopened", DECIDED, { ...META, status: "reopened" as const }, "inline", "open"],
	] as const,
)("card presentation: %s", (_name, value, meta, where, expected) => {
	expect(cardPresentation(value as never, meta, where)).toBe(expected);
});
