import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { parse } from "@chopin/dialect";
import * as room from "./room";
import { protectProjections } from "./projections";

test("experiment references round-trip through headless Lexical and Yjs and remain protected", async () => {
	let errors: unknown[] = [];
	let consoleError = spyOn(console, "error").mockImplementation((...args) => {
		errors.push(args);
	});
	let original = await room.create("# Evidence\n\nKeep this paragraph.\n");
	try {
		let experiment = crypto.randomUUID();
		let decision = crypto.randomUUID();
		expect(room.placeExperiment(original, experiment, "comparison", decision)).toBeDefined();
		await room.settle();
		let source = room.project(original);
		expect(source).toContain(`<Experiment`);
		expect(source).toContain(`decision="${decision}"`);
		room.validate(source);
		let replica = await room.restore(
			original.epoch,
			Y.encodeStateAsUpdate(original.doc),
			source,
			[],
		);
		try {
			expect(room.project(replica)).toBe(source);
		} finally {
			replica.doc.destroy();
		}
		expect(
			protectProjections(
				parse(source).children,
				parse(source.replace(decision, crypto.randomUUID())).children,
			),
		).toBeDefined();
		expect(room.placeExperiment(original, experiment, "comparison", decision)).toBeUndefined();
		expect(room.placeExperiment(original, experiment, "comparison", decision, true)).toBeDefined();
		expect(room.project(original)).not.toContain("<Experiment");
		expect(errors).toEqual([]);
	} finally {
		original.doc.destroy();
		consoleError.mockRestore();
	}
});
