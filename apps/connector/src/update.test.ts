import { afterAll, describe, expect, test } from "bun:test";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledChopin } from "./testing/binary";
import { assets, fakeChopin, fakeRelease, sha256 } from "./testing/release";

/**
 * `chopin update`, run by an installed copy of the compiled binary against a fake release. The
 * releases it installs are shell scripts, so this runs on Linux and macOS.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-update-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
let binary = process.platform === "win32" ? undefined : await compiledChopin(scratch);
let { version } = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
	version: string;
};
let asset = `chopin-${process.platform}-${process.arch}`;

/** A fresh copy of the compiled chopin in its own bin directory, and a gh that records calls. */
async function installed() {
	let home = await mkdtemp(join(scratch, "home-"));
	let bin = join(home, "bin");
	let shims = join(home, "shims");
	await mkdir(bin);
	await mkdir(shims);
	let chopin = join(bin, "chopin");
	await copyFile(binary!, chopin);
	await chmod(chopin, 0o755);
	let log = join(home, "calls.log");
	await writeFile(join(shims, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\n`);
	await chmod(join(shims, "gh"), 0o755);
	let original = sha256(await Bun.file(chopin).bytes());
	return {
		bin,
		chopin,
		calls: async () => (await Bun.file(log).exists()) ? (await readFile(log, "utf8")).trim() : "",
		/** Whether the binary is still the compiled chopin, with nothing left beside it. */
		untouched: async () =>
			sha256(await Bun.file(chopin).bytes()) === original
			&& (await readdir(bin)).join() === "chopin",
		async update(env: Record<string, string>, ...args: string[]) {
			let child = Bun.spawn([chopin, "update", ...args], {
				env: { HOME: home, PATH: `${shims}:${process.env.PATH}`, ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			let [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { code, stdout, stderr };
		},
	};
}

describe.skipIf(!binary)("chopin update", () => {
	test("replaces itself with the newest release after verifying it", async () => {
		using release = fakeRelease({
			"0.0.1": assets(asset, fakeChopin("0.0.1")),
			"99.0.0": assets(asset, fakeChopin("99.0.0")),
		});
		let at = await installed();
		let result = await at.update(release.env);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Updated chopin from ${version} to 99.0.0 at ${at.chopin}`);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("99.0.0"));
		expect(await readdir(at.bin)).toEqual(["chopin"]);
		expect(await at.calls()).toMatch(
			new RegExp(`^gh attestation verify \\S+/${asset} -R githubnext/chopin$`),
		);
	});

	test("refuses a release whose checksum does not match, leaving itself untouched", async () => {
		using release = fakeRelease({
			"99.0.0": assets(asset, fakeChopin("99.0.0"), sha256("something else")),
		});
		let at = await installed();
		let result = await at.update(release.env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Refusing to install it.");
		expect(await at.untouched()).toBe(true);
		expect(await at.calls()).toBe("");
	});

	test("installs an older release when it is named", async () => {
		using release = fakeRelease({
			"0.0.1": assets(asset, fakeChopin("0.0.1")),
			"99.0.0": assets(asset, fakeChopin("99.0.0")),
		});
		let at = await installed();
		let result = await at.update({ ...release.env, CHOPIN_VERIFY_ATTESTATION: "0" }, "cli-v0.0.1");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Updated chopin from ${version} to 0.0.1`);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("0.0.1"));
		expect(release.requests).not.toContain("/api/releases");
		expect(await at.calls()).toBe("");
	});

	test("does nothing when the release is the version already running", async () => {
		using release = fakeRelease({ [version]: assets(asset, fakeChopin(version)) });
		let at = await installed();
		for (let args of [[version], []]) {
			let result = await at.update(release.env, ...args);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(`chopin ${version} is already installed`);
		}
		expect(await at.untouched()).toBe(true);
		// Only the list of releases was read; nothing was downloaded.
		expect(release.requests).toEqual(["/api/releases"]);
	});

	test("refuses a download redirected to plain HTTP", async () => {
		let binary = fakeChopin("99.0.0");
		using release = fakeRelease({
			"99.0.0": { ...assets(asset, binary), [asset]: { redirect: "/cli-v99.0.1/" + asset } },
			"99.0.1": { [asset]: binary },
		});
		let at = await installed();
		let result = await at.update(release.env, "99.0.0");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("which is not HTTPS");
		expect(release.requests).not.toContain(`/cli-v99.0.1/${asset}`);
		expect(await at.untouched()).toBe(true);
	});
});
