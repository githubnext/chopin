import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Controls } from "./controls";
import { AuthoredContent, callouts } from "./authored-content";
import { Foundations } from "./foundations";
import { InteractiveSpecimens } from "./interactive";
import { BuildBlockerAudit } from "./build-blockers";
import { AUDIT_INVENTORY } from "./inventory";
import { Surfaces } from "./surfaces";

function plate(markup: string, item: string): string {
	let start = markup.indexOf(`<section class="design-audit-plate" data-audit-item="${item}">`);
	let end = markup.indexOf("</section>", start);
	return start === -1 || end === -1 ? "" : markup.slice(start, end + "</section>".length);
}

describe("design audit specimens", () => {
	it("renders every foundation family with a visible label", () => {
		let markup = renderToStaticMarkup(createElement(Foundations));

		for (let id of ["colours", "typography", "spacing", "radii", "shadows", "icons"]) {
			expect(markup).toContain(`data-audit-item="${id}"`);
		}
		expect(markup).toContain("Panel close");
		expect(markup).not.toContain("Consolidated exact duplicate");
		expect(markup).toContain("Strong resting");
		expect(markup).toContain("--button-edge-width");
		for (
			let token of [
				"--text-2xs",
				"--text-xs",
				"--text-sm",
				"--text-base",
				"--text-lg",
				"--text-xl",
				"--text-2xl",
			]
		) {
			expect(markup).toContain(`var(${token})`);
		}
	});

	it("inventories and renders every IconLabel tone", () => {
		let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
			candidate => candidate.id === "icon-label",
		);
		expect(item).toEqual({
			id: "icon-label",
			label: "Icon labels",
			source: "packages/visuals/src/ui/icon-label.tsx",
			states: ["neutral", "success", "warning", "danger"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		expect(markup).toContain('data-audit-item="icon-label"');
		for (let tone of ["neutral", "success", "warning", "danger"]) {
			expect(markup).toContain(`data-tone="${tone}"`);
			expect(markup).toContain(`>${tone[0]?.toUpperCase()}${tone.slice(1)}</span>`);
		}
	});

	it("inventories and renders every Badge tone", () => {
		let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
			candidate => candidate.id === "badge",
		);
		expect(item).toEqual({
			id: "badge",
			label: "Badges",
			source: "packages/visuals/src/ui/badge.tsx",
			states: ["neutral", "success", "warning", "danger"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		let specimen = plate(markup, "badge");
		expect(specimen).toContain('data-audit-item="badge"');
		expect(specimen.match(/data-slot="badge"/g)).toHaveLength(4);
		for (let tone of ["neutral", "success", "warning", "danger"]) {
			expect(specimen).toContain(`data-tone="${tone}"`);
			expect(specimen).toContain(`>${tone[0]?.toUpperCase()}${tone.slice(1)}</span>`);
		}
	});

	it("inventories and renders representative Sparkline tones and series", () => {
		let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
			candidate => candidate.id === "sparkline",
		);
		expect(item).toEqual({
			id: "sparkline",
			label: "Sparklines",
			source: "packages/visuals/src/ui/sparkline.tsx",
			states: ["neutral", "success", "warning", "danger"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		expect(markup).toContain('data-audit-item="sparkline"');
		for (let tone of ["neutral", "success", "warning", "danger"]) {
			expect(markup).toContain(`data-tone="${tone}"`);
		}
		expect(markup).toContain('aria-label="Neutral activity"');
		expect(markup).toContain('aria-label="Successful activity"');
		expect(markup).toContain('<path d="M 0 16 L 72 16"');
		expect(markup).toContain('<circle cx="36" cy="16" r="1.5"');
	});

	it("inventories and renders four MiniBars tones with latest-five series", () => {
		let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
			candidate => candidate.id === "mini-bars",
		);
		expect(item).toEqual({
			id: "mini-bars",
			label: "Mini bars",
			source: "packages/visuals/src/ui/mini-bars.tsx",
			states: ["neutral", "success", "warning", "danger"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		let specimen = plate(markup, "mini-bars");
		expect(specimen).toContain('data-audit-item="mini-bars"');
		for (let tone of ["neutral", "success", "warning", "danger"]) {
			expect(specimen).toContain(`aria-label="${tone} volume"`);
			expect(specimen).toContain(`data-tone="${tone}"`);
		}
		expect(specimen.match(/data-slot="mini-bars"/g)).toHaveLength(4);
		expect(specimen.match(/<rect/g)).toHaveLength(20);
	});

	it("inventories and renders zero, in-progress, and complete ProgressBars", () => {
		let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
			candidate => candidate.id === "progress-bar",
		);
		expect(item).toEqual({
			id: "progress-bar",
			label: "Progress bars",
			source: "packages/visuals/src/ui/progress-bar.tsx",
			states: ["zero", "in-progress", "complete"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		let specimen = plate(markup, "progress-bar");
		expect(specimen).toContain('data-audit-item="progress-bar"');
		for (
			let [label, value] of [
				["Not started", 0],
				["In progress", 62.5],
				["Complete", 100],
			] as const
		) {
			expect(specimen).toContain(`aria-label="${label}"`);
			expect(specimen).toContain(`aria-valuenow="${value}"`);
			expect(specimen).toContain(`>${value}%</span>`);
		}
		expect(specimen.match(/role="progressbar"/g)).toHaveLength(3);
	});

	it("adds presentation tables without replacing the authored editor table", () => {
		let items = AUDIT_INVENTORY.flatMap(group => group.items);
		let presentationTable = items.find(candidate => candidate.id === "presentation-table");
		let authoredTable = items.find(candidate => candidate.id === "table");

		expect(presentationTable).toEqual({
			id: "presentation-table",
			label: "Presentation tables",
			source: "packages/visuals/src/ui/table.tsx",
			states: ["plain", "contained", "narrow-overflow"],
		});
		expect(authoredTable).toEqual({
			id: "table",
			label: "Tables",
			source: "packages/editor/src/table/chrome.tsx",
			states: ["default", "selected-cell", "toolbar", "overflow"],
		});

		let markup = renderToStaticMarkup(createElement(Foundations));
		let specimen = plate(markup, "presentation-table");
		expect(specimen).toContain('data-audit-item="presentation-table"');
		expect(specimen).toContain('data-table-example="plain"');
		expect(specimen).toContain('data-table-example="contained-narrow"');
		expect(specimen).toContain('data-variant="plain"');
		expect(specimen).toContain('data-variant="contained"');
		expect(specimen.match(/data-slot="table"/g)).toHaveLength(2);
		expect(specimen.match(/aria-label="Deployment activity"/g)).toHaveLength(2);
		expect(specimen).not.toContain("<caption");
		expect(specimen).toContain("Production Europe West with an intentionally long name");
	});

	it("renders controls with their native accessibility states", () => {
		let markup = renderToStaticMarkup(createElement(Controls));

		for (
			let id of [
				"buttons",
				"icon-buttons",
				"links",
				"fields",
				"selections",
				"tabs",
				"menus",
				"dropdowns",
			]
		) {
			expect(markup).toContain(`data-audit-item="${id}"`);
		}
		expect(markup).toContain('aria-label="Add document"');
		expect(markup).toContain("disabled");
		expect(plate(markup, "selections")).toContain(
			'aria-disabled="true" aria-label="githubnext/design-notes, added"',
		);
		expect(plate(markup, "selections")).toContain('class="navigation-palette-option"');
		expect(markup).not.toContain("design-audit-selection-list");
		expect(markup).toContain('role="menu"');
		expect(plate(markup, "dropdowns")).toContain(
			'class="navigation-account-menu motion-dropdown is-open"',
		);
		expect(plate(markup, "dropdowns")).toContain("Manage repository access");
		expect(markup).not.toContain("design-audit-dropdown-trigger");
		expect(markup).not.toContain('data-slot="select-trigger"');
		for (let id of ["buttons", "icon-buttons", "links", "fields"]) {
			expect(plate(markup, id)).not.toContain("data-audit-state");
		}
		expect(markup).toMatch(/aria-busy="true"[^>]*disabled[^>]*>[\s\S]*data-button-loader/);
		expect(markup).toContain('class="field h-8 w-full px-2 text-sm"');
		expect(markup).toContain('class="app-icon-button btn');
		expect(markup).toContain('class="link text-sm"');
		for (let state of ["hover", "active", "focus"]) {
			expect(markup).toContain(`data-force-state="${state}"`);
		}
	});

	it("shows control states through the production rules", async () => {
		let audit = await Bun.file(new URL("./controls.css", import.meta.url)).text();
		let theme = await Bun.file(new URL("../theme.css", import.meta.url)).text();

		expect(audit).not.toContain(".btn-");
		expect(audit).not.toContain("design-audit-link");
		expect(theme).toContain('&:is(:hover, [data-force-state="hover"]):not(:disabled)');
		expect(theme).toContain('&:is(:active, [data-force-state="active"]):not(:disabled)');
		expect(theme).toContain("@utility link");
	});

	it("renders every application surface and its meaningful states", () => {
		let markup = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(Surfaces),
				createElement(InteractiveSpecimens),
				createElement(BuildBlockerAudit),
			),
		);

		for (let item of AUDIT_INVENTORY.find(group => group.id === "surfaces")!.items) {
			expect(markup).toContain(`data-audit-item="${item.id}"`);
		}
		expect(plate(markup, "dialogs")).toContain('role="group"');
		expect(plate(markup, "dialogs")).not.toContain('aria-modal="true"');
		expect(markup).toContain('aria-current="page"');
		expect(markup).toContain('aria-label="Workspace view"');
		let navigation = plate(markup, "navigation");
		expect(navigation).toContain("project-sidebar-document-current");
		expect(navigation).toContain("project-sidebar-document-ancestor");
		expect(navigation).toContain("project-sidebar-child-current");
		expect(navigation).toContain('data-sidebar-decision-count=""');
		expect(navigation).toContain("Loading documents…");
		expect(navigation).not.toContain("Archived draft");
		expect(plate(markup, "lists")).toContain('class="navigation-palette-option"');
		expect(plate(markup, "lists")).toContain('class="document-status-badge">Archived<');
		let empty = plate(markup, "empty");
		expect(empty).toContain('<p class="project-sidebar-empty">No documents</p>');
		expect(empty).toContain('<p class="project-sidebar-empty">No archived documents</p>');
		expect(empty).toContain("No matching documents");
		expect(markup).toContain('data-chat-entry="true"');
		let chat = plate(markup, "chat");
		expect(chat).toContain('class="workspace-root');
		expect(chat).toContain('class="composer-surface field"');
		expect(chat).toContain('class="composer-notice motion-feedback"');
		expect(chat).toContain("Reconnect");
		expect(chat).toContain('aria-label="Stop Chopin"');
		expect(chat).toContain("Read-only access");
		expect(chat).toContain("Document archived");
		expect(chat).not.toContain("<textarea");
		expect(chat).not.toContain("design-audit-chat-error");
		expect(plate(markup, "errors")).toContain('class="btn btn-sm btn-outline-danger"');
		expect(markup).toContain("Avatar image loading");
		expect(markup).toContain("Editing this question");
		expect(markup).toContain('role="alert"');
		expect(markup).toMatch(
			/<button aria-busy="true" class="btn btn-md btn-primary" disabled=""[^>]*>/,
		);
		expect(markup).toContain('data-button-loader=""');
	});

	it("renders every authored-content family through the static editor or record card", () => {
		let markup = renderToStaticMarkup(createElement(AuthoredContent));

		for (let item of AUDIT_INVENTORY.find(group => group.id === "authored-content")!.items) {
			expect(markup).toContain(`data-audit-item="${item.id}"`);
		}
		expect(markup).toContain('role="document"');
		for (let type of ["note", "tip", "important", "warning", "danger"]) {
			expect(callouts).toContain(`type="${type}"`);
		}
		expect(markup).toContain("Research question");
		expect(markup).toContain("Research failed");
	});
});
