import { expect, test } from "bun:test";
import * as Visuals from "@chopin/visuals";

test("publishes the component and stylesheet entry points", () => {
	expect(() => Bun.resolveSync("@chopin/visuals", import.meta.dir)).not.toThrow();
	expect(() => Bun.resolveSync("@chopin/visuals/styles.css", import.meta.dir)).not.toThrow();
});

test("publishes the complete Select composition", () => {
	for (let name of ["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"]) {
		expect(name in Visuals).toBe(true);
	}
});
