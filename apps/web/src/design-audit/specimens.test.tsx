import { describe, expect, it } from "bun:test";
import { SelectItem } from "@chopin/visuals";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Controls } from "./controls";
import { AuthoredContent, callouts } from "./authored-content";
import { Foundations } from "./foundations";
import { AUDIT_INVENTORY } from "./inventory";
import { Surfaces } from "./surfaces";

import type { ReactElement, ReactNode } from "react";

function plate(markup: string, item: string): string {
	let start = markup.indexOf(`<section class="design-audit-plate" data-audit-item="${item}">`);
	let end = markup.indexOf("</section>", start);
	return start === -1 || end === -1 ? "" : markup.slice(start, end + "</section>".length);
}

function elementsOfType(
	node: ReactNode,
	type: ReactElement["type"],
	found: ReactElement<{ children?: ReactNode; value?: unknown }>[] = [],
) {
	Children.forEach(node, child => {
		if (!isValidElement<{ children?: ReactNode; value?: unknown }>(child)) return;
		if (child.type === type) found.push(child);
		elementsOfType(child.props.children, type, found);
	});
	return found;
}

describe("design audit specimens", () => {
	it("renders every foundation family with a visible label", () => {
		let markup = renderToStaticMarkup(createElement(Foundations));

		for (let id of ["colours", "typography", "spacing", "radii", "shadows", "icons"]) {
			expect(markup).toContain(`data-audit-item="${id}"`);
		}
		expect(markup).toContain("Consolidated exact duplicate");
		expect(markup).toContain("Strong resting");
		expect(markup).toContain("--button-edge-width");
		for (
			let measurement of [
				"13px / 20px line-height",
				"15px / 22px line-height",
				"17px / 27px line-height",
				"24px / 30px line-height",
				"32px / 38px line-height",
			]
		) expect(markup).toContain(measurement);
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
		expect(specimen).toContain('data-table-example="contained-overflow"');
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
		expect(markup).toContain('aria-selected="true"');
		expect(markup).toContain('role="menu"');
		expect(markup).toContain('data-slot="select-trigger"');
		expect(markup).toContain('data-slot="select-value"');
		expect(markup).not.toContain('<select class="field"');
		expect(markup).toMatch(/aria-busy="true"[^>]*disabled[^>]*>[\s\S]*data-button-loader/);
		expect(
			elementsOfType(Controls(), SelectItem).map(item => [item.props.value, item.props.children]),
		).toEqual([
			["active", "Active documents"],
			["archived", "Archived documents"],
		]);
	});

	it("gives focused audit links breathing room", async () => {
		let css = await Bun.file(new URL("./controls.css", import.meta.url)).text();

		expect(css).toMatch(
			/\.design-audit-link:is\(\[data-audit-state="focus"\], :focus-visible\)[\s\S]*margin-inline:\s*-0\.25rem;[\s\S]*padding-inline:\s*0\.25rem;/,
		);
	});

	it("renders every application surface and its meaningful states", () => {
		let markup = renderToStaticMarkup(createElement(Surfaces));

		for (let item of AUDIT_INVENTORY.find(group => group.id === "surfaces")!.items) {
			expect(markup).toContain(`data-audit-item="${item.id}"`);
		}
		expect(markup).toContain('role="dialog"');
		expect(markup).toContain('aria-current="page"');
		expect(markup).toContain('aria-label="Compact workspace view"');
		expect(markup).toContain('data-chat-entry="true"');
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
		expect(markup).toContain("Research ready");
	});
});
