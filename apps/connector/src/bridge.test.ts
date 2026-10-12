import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { bridgeCommand } from "./bridge";

test("a connector run as a script starts its bridge by running that script again", () => {
	expect(bridgeCommand(false, "/usr/local/bin/bun", "connector.js")).toEqual({
		command: "/usr/local/bin/bun",
		args: [resolve("connector.js"), "bridge"],
	});
});

test("a compiled chopin binary starts its bridge as itself, without a script argument", () => {
	// Its argv[1] is a virtual path inside the binary, which no other process can run.
	expect(bridgeCommand(true, "/home/ana/.local/bin/chopin", "/$bunfs/root/chopin")).toEqual({
		command: "/home/ana/.local/bin/chopin",
		args: ["bridge"],
	});
});
