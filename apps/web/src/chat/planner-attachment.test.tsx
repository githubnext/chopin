import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlannerAttachment } from "./planner-attachment";

import type { Session } from "@chopin/protocol";

function render(planner: Session.PlannerAttachment | undefined, machine?: string): string {
	return renderToStaticMarkup(
		createElement(PlannerAttachment, { planner, ...(machine ? { machine } : {}) }),
	);
}

/** The words a person reads, without markup. */
function words(markup: string): string {
	return markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

test("names the attached Planner's login as a polite status", () => {
	let markup = render({ state: "attached", login: "lavaman131" });
	expect(words(markup)).toBe("Planner: lavaman131 attached");
	expect(markup).toContain('role="status"');
	expect(markup).toContain('data-planner-state="attached"');
});

test("says no Planner is attached and that @chopin needs one", () => {
	let markup = render({ state: "none" });
	expect(words(markup)).toBe("Planner: none attached. @chopin needs an attached Planner.");
	expect(markup).toContain('data-planner-state="none"');
});

test("says who detached and until when the document is held for them", () => {
	let until = "2026-10-12T19:42:00.000Z";
	let time = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	let markup = render({ state: "held", login: "lavaman131", until });
	expect(words(markup)).toBe(`Planner: lavaman131 detached, held until ${time}`);
	expect(markup).toContain(`<time dateTime="${until}">${time}</time>`);
	expect(markup).toContain('data-planner-state="held"');
});

test("names the machine starting the Planner when it is the viewer's, else whose it is", () => {
	let markup = render({ state: "starting", login: "mona" }, "studio");
	expect(words(markup)).toBe("Planner: starting on studio…");
	expect(markup).toContain('data-planner-state="starting"');
	expect(words(render({ state: "starting", login: "mona" }))).toBe(
		"Planner: starting on @mona’s machine…",
	);
});

test("says why a Planner a machine keeps failing to start cannot, still as starting and still trying", () => {
	let at = "2026-11-04T02:05:16.000Z";
	let time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	let failure = {
		attempts: 3,
		reason: "unsafe-checkout: ~/src/score sets a credential helper",
		at,
	};
	let markup = render({ state: "starting", login: "mona", failure }, "studio");
	expect(words(markup)).toBe(
		"Planner: can’t start on studio unsafe-checkout: ~/src/score sets a credential helper "
			+ `Tried 3 times in a row, last at ${time}. Still trying.`,
	);
	// It is still the starting state, so everything that follows it still does, and it is said aloud.
	expect(markup).toContain('data-planner-state="starting"');
	expect(markup).toContain("data-planner-failing");
	expect(markup).toContain('role="status"');
	expect(markup).toContain(`<time dateTime="${at}">${time}</time>`);
	// The reason is text, never markup.
	expect(render({ state: "starting", login: "mona", failure: { ...failure, reason: "<b>no</b>" } }))
		.toContain("&lt;b&gt;no&lt;/b&gt;");
	// Somebody else's machine is named as whose it is.
	expect(words(render({ state: "starting", login: "mona", failure }))).toStartWith(
		"Planner: can’t start on @mona’s machine ",
	);
	// Without a failure, nothing about one is said.
	expect(render({ state: "starting", login: "mona" }, "studio")).not.toContain(
		"data-planner-failing",
	);
});

test("keeps its status dot out of the accessible text", () => {
	let markup = render({ state: "attached", login: "lavaman131" });
	expect(markup).toMatch(/<span aria-hidden="true" class="composer-planner-dot"><\/span>/);
});

test("shows nothing where the server reports no Planner attachments, as for other harnesses", () => {
	expect(render(undefined)).toBe("");
});
