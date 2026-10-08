import { expect, test } from "bun:test";

import {
	advanceDocumentActivity,
	documentActivity,
	documentActivityLabel,
	QUIET_DOCUMENT,
} from "./document-activity";

import type { DocumentActivityEvent } from "./document-activity";

let run = (...events: DocumentActivityEvent[]) =>
	events.reduce(advanceDocumentActivity, QUIET_DOCUMENT);

test("answering out of view shows writing while the turn runs, then nothing", () => {
	let answered = run({ type: "answered" });
	expect(documentActivity(answered, true)).toBe("writing");
	expect(documentActivity(answered, false)).toBeUndefined();
	expect(documentActivity(run({ type: "answered" }, { type: "idle" }), true)).toBeUndefined();
});

test("changes out of view stay unseen after the turn ends until the document is seen", () => {
	let written = run({ type: "answered" }, { type: "changes" });
	expect(documentActivity(written, true)).toBe("writing");
	let ended = advanceDocumentActivity(written, { type: "idle" });
	expect(documentActivity(ended, false)).toBe("unseen");
	expect(documentActivity(advanceDocumentActivity(ended, { type: "seen" }), false))
		.toBeUndefined();
});

test("a busy turn alone never claims the document is being written", () => {
	expect(documentActivity(QUIET_DOCUMENT, true)).toBeUndefined();
});

test("settled events keep state identity", () => {
	let written = run({ type: "changes" });
	expect(advanceDocumentActivity(written, { type: "changes" })).toBe(written);
	expect(advanceDocumentActivity(QUIET_DOCUMENT, { type: "seen" })).toBe(QUIET_DOCUMENT);
	expect(advanceDocumentActivity(QUIET_DOCUMENT, { type: "idle" })).toBe(QUIET_DOCUMENT);
});

test("labels name the activity for assistive technology", () => {
	expect(documentActivityLabel("writing")).toBe("Document, Planner writing");
	expect(documentActivityLabel("unseen")).toBe("Document, new changes");
	expect(documentActivityLabel(undefined)).toBe("Document");
});
