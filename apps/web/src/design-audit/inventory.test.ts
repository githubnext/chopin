import { describe, expect, it } from "bun:test";

import { AUDIT_INVENTORY } from "./inventory";

const REQUIRED = [
	"colours",
	"typography",
	"spacing",
	"radii",
	"shadows",
	"icons",
	"buttons",
	"icon-buttons",
	"links",
	"fields",
	"selections",
	"tabs",
	"menus",
	"dropdowns",
	"dialogs",
	"lists",
	"navigation",
	"chat",
	"decisions",
	"resolved-comments",
	"loading",
	"empty",
	"errors",
	"callouts",
	"research",
	"code",
	"diff",
	"diagram",
	"formula",
	"image",
	"table",
] as const;

describe("design audit inventory", () => {
	it("covers every required system area exactly once", () => {
		expect(AUDIT_INVENTORY.map(group => group.id)).toEqual([
			"foundations",
			"controls",
			"surfaces",
			"authored-content",
		]);

		let items = AUDIT_INVENTORY.flatMap(group => group.items);
		let ids = items.map(item => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(REQUIRED.every(id => ids.includes(id))).toBe(true);
	});

	it("records an inspectable source and state for every specimen", () => {
		for (let group of AUDIT_INVENTORY) {
			for (let item of group.items) {
				expect(item.label.trim().length).toBeGreaterThan(0);
				expect(item.source).toMatch(/^(?:apps|packages)\//);
				expect(item.states.length).toBeGreaterThan(0);
			}
		}
	});
});
