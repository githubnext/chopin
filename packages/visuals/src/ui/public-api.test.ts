import { expect, test } from "bun:test";

test("publishes the component and stylesheet entry points", () => {
	expect(() => Bun.resolveSync("@chopin/visuals", import.meta.dir)).not.toThrow();
	expect(() => Bun.resolveSync("@chopin/visuals/styles.css", import.meta.dir)).not.toThrow();
});
