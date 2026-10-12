import { expect, test } from "bun:test";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { bridgeCommand } from "./bridge";

test("a connector run as a script starts its bridge by running that script again", () => {
	// The agent may start the bridge in the checkout, whose .env and bunfig.toml must not load.
	expect(bridgeCommand(false, "/usr/local/bin/bun", "connector.js")).toEqual({
		command: "/usr/local/bin/bun",
		args: ["--no-env-file", `--config=${devNull}`, resolve("connector.js"), "bridge"],
	});
});

test("a compiled chopin binary starts its bridge as itself, without a script argument", () => {
	// Its argv[1] is a virtual path inside the binary, which no other process can run.
	expect(bridgeCommand(true, "/home/ana/.local/bin/chopin", "/$bunfs/root/chopin")).toEqual({
		command: "/home/ana/.local/bin/chopin",
		args: ["bridge"],
	});
});
