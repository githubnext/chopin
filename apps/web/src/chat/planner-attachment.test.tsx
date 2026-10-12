import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PlannerAttachment } from "./planner-attachment";

import type { Session } from "@chopin/protocol";

function render(planner: Session.PlannerAttachment | undefined): string {
	return renderToStaticMarkup(createElement(PlannerAttachment, { planner }));
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

test("keeps its status dot out of the accessible text", () => {
	let markup = render({ state: "attached", login: "lavaman131" });
	expect(markup).toMatch(/<span aria-hidden="true" class="composer-planner-dot"><\/span>/);
});

test("shows nothing where the server reports no Planner attachments, as for other harnesses", () => {
	expect(render(undefined)).toBe("");
});
