import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Transcript } from "./transcript";
import type { CardMetaStore, QuestionnaireStore } from "@chopin/editor";
import type { Question } from "@chopin/protocol";
import { prompt, questionnaire } from "./transcript-decisions.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks.
test("transcript connects the newest prompt to the shared question and meta snapshots", () => {
	let questions = {
		subscribe: () => () => {},
		snapshot: () => [{ id: "Q", value: questionnaire }],
	} as unknown as QuestionnaireStore;
	let meta: Question.CardMeta = {
		status: "open",
		origin: "conversation",
		involved: [],
		history: [{ choices: ["a"], owner: "mina", at: 1_700_000_000 }],
		optionOrigins: {},
		hasProse: false,
		refining: false,
		proseOrphaned: false,
		suggested: { optionId: "b", messageIds: ["m2"], revision: 4 },
	};
	let cardMeta = {
		subscribe: () => () => {},
		snapshot: () => new Map([["Q", meta]]),
	} as unknown as CardMetaStore;
	let markup = renderToStaticMarkup(createElement(Transcript, {
		active: true,
		decisions: {
			questions,
			meta: cardMeta,
			connected: false,
			canEdit: true,
			onOpenCard() {},
		},
		entries: [prompt("old-prompt", 0), prompt("new-prompt", 1)],
		handle: "ana",
		onWithdraw: () => {},
		queued: [],
	}));

	expect(markup).toContain("Superseded by a later prompt");
	expect(markup).toContain("Ready to settle: <span");
	expect(markup).toContain("GitHub Apps");
	expect(markup).toContain("Decision prompt: What auth system should we use?");
	expect(markup.match(/>Open card</g)).toHaveLength(2);
	expect(markup).not.toContain("Save decision");
});
