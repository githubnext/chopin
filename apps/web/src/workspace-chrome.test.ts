import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DocumentTitleBar } from "./document-title-bar";
import { UndoRefusedNotice } from "./document-status-notices";
import { workspaceDestinations } from "./workspace-model";
import { destinationLabel, WorkspaceViewNavigation } from "./workspace-navigation";

import type { ComponentProps } from "react";

let navigation = (props: Partial<ComponentProps<typeof WorkspaceViewNavigation>> = {}) =>
	renderToStaticMarkup(createElement(WorkspaceViewNavigation, {
		buildEnabled: true,
		buildReason: "reason",
		buildUnavailable: "Build the plan to see its tasks",
		chatActivity: { busy: false, unread: 0 },
		chatVisible: false,
		destinations: workspaceDestinations(true),
		implementation: true,
		onNavigate: () => {},
		unanswered: 0,
		view: "plan",
		...props,
	}));

test("compact navigation marks one current destination", () => {
	let markup = navigation({ chatVisible: true });
	expect(markup).toContain('aria-label="Workspace view"');
	expect(markup).toContain("grid-cols-4");
	expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
	expect(markup).toMatch(/aria-current="page" aria-label="Chat"/);
});

test("compact navigation describes Build while it cannot open", () => {
	let markup = navigation({ buildEnabled: false });
	expect(markup).toContain('aria-describedby="reason"');
	expect(markup).toContain('aria-disabled="true"');
	expect(markup).toContain('id="reason"');
	expect(navigation({ implementation: false, destinations: workspaceDestinations() }))
		.toContain("grid-cols-3");
});

test("compact navigation counts unanswered decisions and Chat activity", () => {
	let markup = navigation({ chatActivity: { busy: true, unread: 2 }, unanswered: 3 });
	expect(markup).toContain('aria-label="Decisions, 3 unanswered"');
	expect(markup).toContain('aria-label="Chat, Planner working, 2 unread"');
	expect(markup).toContain("data-plan-decision-count");
	expect(destinationLabel("plan", 0, { busy: false, unread: 0 }, "writing"))
		.toBe("Document, Planner writing");
});

test("the title bar keeps its container, slots and the views bar beneath it", () => {
	let markup = renderToStaticMarkup(createElement(DocumentTitleBar, {
		controls: "views",
		status: "status",
		title: "title",
		titleInert: true,
		toggle: "toggle",
		viewsFolded: true,
	}));
	expect(markup).toContain("data-document-title-bar");
	expect(markup).toContain("workspace-surface-toggle-slot");
	expect(markup).toContain('<div class="document-title-slot" inert="">title</div>');
	expect(markup).toContain('<div class="document-title-status">status</div>');
	expect(markup).toMatch(/data-document-toolbar="true" data-folded="true" inert=""/);
	expect(renderToStaticMarkup(createElement(DocumentTitleBar, { controls: null, title: "t" })))
		.not.toContain("workspace-surface-toggle-slot");
});

test("the undo refusal names its reason", () => {
	expect(renderToStaticMarkup(createElement(UndoRefusedNotice, { reason: "others" })))
		.toContain("Others have edited this since.");
});
