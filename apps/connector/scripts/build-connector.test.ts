import { afterAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeBundle } from "./build-binaries";
import { buildConnector } from "./build-connector";

let scratch = await mkdtemp(join(tmpdir(), "chopin-connector-build-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

test(
	"connector.js carries the bridge its microVMs run, and writes it from anywhere, the binary's own",
	async () => {
		// What connector.js does to start its microVMs, bundled as connector.js is, then run alone.
		let entry = join(scratch, "probe.ts");
		await writeFile(
			entry,
			`import { guestBridge } from ${
				JSON.stringify(join(import.meta.dir, "../src/bridge"))
			};\nconsole.log(await guestBridge(process.argv[2]!));\n`,
		);
		let built = await buildConnector(join(scratch, "build", "probe.js"), entry);
		let alone = join(scratch, "alone");
		await Bun.$`mkdir -p ${alone}`;
		await copyFile(built, join(alone, "probe.js"));
		let base = join(scratch, "state");
		let run = Bun.spawnSync([process.execPath, join(alone, "probe.js"), base], { cwd: alone });
		expect(run.stderr.toString()).toBe("");
		let written = run.stdout.toString().trim();
		expect(written.startsWith(join(base, "nvx", "bridge"))).toBe(true);
		let expected = await readFile(await bridgeBundle(join(scratch)), "utf8");
		expect(await readFile(written, "utf8")).toBe(expected);
	},
	60_000,
);
