import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	advanceDocumentActivity,
	documentActivity,
	documentActivityLabel,
	QUIET_DOCUMENT,
} from "./document-activity";

import type { DocumentActivityEvent } from "./document-activity";

let run = (...events: DocumentActivityEvent[]) =>
	events.reduce(advanceDocumentActivity, QUIET_DOCUMENT);

test("an answer out of view shows writing once its turn resumes, then nothing", () => {
	let answered = run({ type: "answered", busy: false });
	expect(documentActivity(answered, false)).toBeUndefined();
	let resumed = advanceDocumentActivity(answered, { type: "started" });
	expect(documentActivity(resumed, true)).toBe("writing");
	expect(documentActivity(advanceDocumentActivity(resumed, { type: "idle" }), false))
		.toBeUndefined();
});

test("an answer to a turn that is still running follows it at once", () => {
	expect(documentActivity(run({ type: "answered", busy: true }), true)).toBe("writing");
});

test("an answer whose turn never starts expires before an unrelated turn", () => {
	let expired = run({ type: "answered", busy: false }, { type: "expired" }, { type: "started" });
	expect(documentActivity(expired, true)).toBeUndefined();
});

test("a turn with no answer of this viewer's, such as after a discard, never claims writing", () => {
	expect(documentActivity(run({ type: "started" }), true)).toBeUndefined();
});

test("older unseen changes do not make an unrelated turn read as writing", () => {
	let waiting = run({ type: "changes", busy: false }, { type: "started" });
	expect(documentActivity(waiting, true)).toBe("unseen");
});

test("changes during a turn mark it writing, then unseen until the document is seen", () => {
	let written = run({ type: "started" }, { type: "changes", busy: true });
	expect(documentActivity(written, true)).toBe("writing");
	let ended = advanceDocumentActivity(written, { type: "idle" });
	expect(documentActivity(ended, false)).toBe("unseen");
	expect(documentActivity(advanceDocumentActivity(ended, { type: "seen" }), false))
		.toBeUndefined();
});

test("settled events keep state identity", () => {
	let written = run({ type: "changes", busy: false });
	expect(advanceDocumentActivity(written, { type: "changes", busy: false })).toBe(written);
	expect(advanceDocumentActivity(QUIET_DOCUMENT, { type: "seen" })).toBe(QUIET_DOCUMENT);
	expect(advanceDocumentActivity(QUIET_DOCUMENT, { type: "idle" })).toBe(QUIET_DOCUMENT);
	expect(advanceDocumentActivity(QUIET_DOCUMENT, { type: "expired" })).toBe(QUIET_DOCUMENT);
});

test("labels name the activity for assistive technology", () => {
	expect(documentActivityLabel("writing")).toBe("Document, Planner writing");
	expect(documentActivityLabel("unseen")).toBe("Document, new changes");
	expect(documentActivityLabel(undefined)).toBe("Document");
});

test("the writing pulse only runs when motion is allowed", () => {
	let css = readFileSync(join(import.meta.dir, "theme.css"), "utf8");
	let rule = /\.document-activity-dot\[data-document-activity="writing"\]\s*\{[^}]*animation:/;
	let allowed = css.match(
		/@media \(prefers-reduced-motion: no-preference\) \{\s*\.document-activity-dot[^]*?\n\}/,
	);
	expect(allowed?.[0]).toMatch(rule);
	expect(css.replace(allowed![0], "")).not.toMatch(rule);
});
