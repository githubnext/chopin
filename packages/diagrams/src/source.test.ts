import { describe, expect, it } from "bun:test";

import { MAX_DIAGRAM_SOURCE_BYTES, parseDiagramSource } from "./source";

describe("saved diagram source", () => {
	it("decodes one declarative JSON value", () => {
		expect(parseDiagramSource('{"type":"architecture","nodes":[],"edges":[]}')).toEqual({
			ok: true,
			spec: { type: "architecture", nodes: [], edges: [] },
		});
	});

	it("bounds source bytes before parsing and does not echo malformed source", () => {
		expect(parseDiagramSource("é".repeat(MAX_DIAGRAM_SOURCE_BYTES / 2 + 1))).toEqual({
			ok: false,
			message: "Diagram source is too large (64 KiB maximum).",
		});
		expect(parseDiagramSource('{"secret":"unfinished')).toEqual({
			ok: false,
			message: "Diagram source must be valid JSON.",
		});
	});
});
