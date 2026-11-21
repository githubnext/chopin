import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { guestBridge, guestBridgeCommand } from "./bridge";

test("a run's guest gets the MCP bridge as one file its image's Node runs, named by what is in it", async () => {
	let base = mkdtempSync(join(tmpdir(), "chopin-bridge-"));
	try {
		let path = await guestBridge(base);
		expect(path.startsWith(join(base, "nvx", "bridge"))).toBe(true);
		expect(basename(path)).toMatch(/^[0-9a-f]{16}\.mjs$/);
		expect(await guestBridge(base)).toBe(path);
		let bundle = readFileSync(path, "utf8");
		// Node runs it in the guest, where there is no Bun.
		expect(bundle).not.toMatch(/\bBun\./);
		let checked = spawnSync("node", ["--check", path], { encoding: "utf8" });
		if (!checked.error) expect(checked.status).toBe(0);
		expect(guestBridgeCommand()).toEqual({
			command: "/opt/chopin/agent/node/bin/node",
			args: ["/opt/chopin/bridge.mjs"],
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
