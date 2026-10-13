import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
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
import { recover, replace } from "./update";

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
		/** Without a terminal: stdin is not a TTY. */
		async update(env: Record<string, string>, ...args: string[]) {
			let child = Bun.spawn([chopin, "update", ...args], {
				env: { HOME: home, PATH: `${shims}:${process.env.PATH}`, ...env },
				stdin: "ignore",
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
		/** On a terminal, answering a confirmation prompt with `answer` if one is shown. */
		async interactive(env: Record<string, string>, answer: string, ...args: string[]) {
			let output = "";
			let prompted = Promise.withResolvers<void>();
			let child = Bun.spawn([chopin, "update", ...args], {
				env: { HOME: home, PATH: `${shims}:${process.env.PATH}`, ...env },
				terminal: {
					cols: 200,
					rows: 24,
					data(_terminal, data) {
						output += new TextDecoder().decode(data);
						if (output.includes("[y/N]")) prompted.resolve();
					},
				},
			});
			await Promise.race([prompted.promise, child.exited]);
			child.terminal!.write(`${answer}\r`);
			let code = await child.exited;
			child.terminal!.close();
			return { code, output };
		},
	};
}

/** A Chopin server that recommends `version` to connectors. */
function chopinServer(recommended: string | null) {
	let requests: string[] = [];
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests.push(new URL(request.url).pathname);
			return Response.json({ protocol: { min: 1, max: 1 }, version: recommended });
		},
	});
	return {
		requests,
		url: `http://127.0.0.1:${server.port}`,
		[Symbol.dispose]: () => void server.stop(true),
	};
}

/** Releases 0.0.0, 98.0.0 and 99.0.0, the newest, on either side of the running version. */
function releases() {
	return fakeRelease({
		"0.0.0": assets(asset, fakeChopin("0.0.0")),
		"98.0.0": assets(asset, fakeChopin("98.0.0")),
		"99.0.0": assets(asset, fakeChopin("99.0.0")),
	});
}

describe.skipIf(!binary)("chopin update", () => {
	test("installs the release the Chopin server recommends after verifying it", async () => {
		using release = releases();
		using chopin = chopinServer("98.0.0");
		let at = await installed();
		// Without a terminal, an upgrade needs no --yes.
		let result = await at.update({ ...release.env, CHOPIN_URL: chopin.url });
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Updated chopin from ${version} to 98.0.0 at ${at.chopin}`);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("98.0.0"));
		expect(await readdir(at.bin)).toEqual(["chopin"]);
		expect(chopin.requests).toEqual(["/api/connector/version"]);
		expect(release.requests).not.toContain("/api/releases");
		expect(await at.calls()).toMatch(
			new RegExp(`^gh attestation verify \\S+/${asset} -R githubnext/chopin$`),
		);
	});

	test("installs the newest release when the Chopin server cannot be reached", async () => {
		using release = releases();
		let closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
		let url = `http://127.0.0.1:${closed.port}`;
		await closed.stop(true);
		let at = await installed();
		let result = await at.update({ ...release.env, CHOPIN_URL: url });
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Could not ask ${url} which chopin to install`);
		expect(result.stdout).toContain("installing the newest release, 99.0.0, instead");
		expect(result.stdout).toContain(`Updated chopin from ${version} to 99.0.0`);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("99.0.0"));
	});

	test("moves to an older release only with --allow-downgrade", async () => {
		using release = releases();
		using chopin = chopinServer("0.0.0");
		let env = { ...release.env, CHOPIN_URL: chopin.url, CHOPIN_VERIFY_ATTESTATION: "0" };
		let at = await installed();
		// Recommended by the server or named, the refusal gives the command that goes ahead.
		for (let args of [[], ["cli-v0.0.0"]]) {
			let refused = await at.update(env, ...args);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain(
				`0.0.0 is older than the installed chopin ${version}. To install it anyway, run: `
					+ "chopin update 0.0.0 --allow-downgrade",
			);
			expect(await at.untouched()).toBe(true);
		}
		expect(release.requests).toEqual([]);

		let result = await at.update(env, "--allow-downgrade");
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`Updated chopin from ${version} to 0.0.0`);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("0.0.0"));
	});

	test("installs a named release over the server's recommendation", async () => {
		using release = releases();
		using chopin = chopinServer("98.0.0");
		let at = await installed();
		let result = await at.update({ ...release.env, CHOPIN_URL: chopin.url }, "99.0.0");
		expect(result.code).toBe(0);
		expect(await readFile(at.chopin, "utf8")).toBe(fakeChopin("99.0.0"));
		expect(chopin.requests).toEqual([]);
	});

	test("refuses a release whose checksum does not match, leaving itself untouched", async () => {
		using release = fakeRelease({
			"99.0.0": assets(asset, fakeChopin("99.0.0"), sha256("something else")),
		});
		using chopin = chopinServer("99.0.0");
		let at = await installed();
		let result = await at.update({ ...release.env, CHOPIN_URL: chopin.url });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Refusing to install it.");
		expect(await at.untouched()).toBe(true);
		expect(await at.calls()).toBe("");
	});

	test("does nothing when the release is the version already running", async () => {
		using release = fakeRelease({ [version]: assets(asset, fakeChopin(version)) });
		using chopin = chopinServer(version);
		let at = await installed();
		for (let args of [[version], []]) {
			let result = await at.update({ ...release.env, CHOPIN_URL: chopin.url }, ...args);
			expect(result.stderr).toBe("");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain(`chopin ${version} is already installed`);
		}
		expect(await at.untouched()).toBe(true);
		expect(release.requests).toEqual([]);
	});

	test("refuses a download redirected to plain HTTP", async () => {
		let binary = fakeChopin("99.0.0");
		using release = fakeRelease({
			"99.0.0": { ...assets(asset, binary), [asset]: { redirect: "/cli-v99.0.1/" + asset } },
			"99.0.1": { [asset]: binary },
		});
		using chopin = chopinServer("99.0.0");
		let at = await installed();
		let result = await at.update({ ...release.env, CHOPIN_URL: chopin.url });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("which is not HTTPS");
		expect(release.requests).not.toContain(`/cli-v99.0.1/${asset}`);
		expect(await at.untouched()).toBe(true);
	});

	test("asks before replacing itself on a terminal, unless given --yes", async () => {
		using release = releases();
		using chopin = chopinServer("99.0.0");
		let env = { ...release.env, CHOPIN_URL: chopin.url, CHOPIN_VERIFY_ATTESTATION: "0" };
		let at = await installed();
		let declined = await at.interactive(env, "n");
		expect(declined.output).toContain(`Update chopin from ${version} to 99.0.0? [y/N]`);
		expect(declined.code).toBe(1);
		expect(await at.untouched()).toBe(true);
		expect(release.requests).toEqual([]);

		let accepted = await at.interactive(env, "y");
		expect(accepted.code).toBe(0);
		expect(accepted.output).toContain(`Updated chopin from ${version} to 99.0.0`);

		let fresh = await installed();
		let yes = await fresh.interactive(env, "", "--yes");
		expect(yes.output).not.toContain("[y/N]");
		expect(yes.code).toBe(0);
		expect(await readFile(fresh.chopin, "utf8")).toBe(fakeChopin("99.0.0"));
	});
});

/** The swap itself, on a real directory, with the Windows rename-aside run on any OS. */
describe("replacing the binary", () => {
	async function folder(files: Record<string, string>) {
		let dir = await mkdtemp(join(scratch, "replace-"));
		for (let [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
		let contents = async () =>
			Object.fromEntries(
				await Promise.all(
					(await readdir(dir)).sort().map(async name => [
						name,
						await readFile(join(dir, name), "utf8"),
					]),
				),
			);
		return { target: join(dir, "chopin.exe"), contents };
	}

	test("restores a target that an interrupted update left only as <target>.old", async () => {
		let at = await folder({ "chopin.exe.old": "old" });
		let renames: string[][] = [];
		let files = {
			...fs,
			rename: (from: string, to: string) => (renames.push([from, to]), fs.rename(from, to)),
		};
		let said: string[] = [];
		expect(await recover(at.target, { files, log: line => said.push(line) })).toBe(true);
		expect(renames).toEqual([[`${at.target}.old`, at.target]]);
		expect(said).toEqual([
			`Restored ${at.target} from ${at.target}.old, left by an update that was interrupted.`,
		]);
		expect(await at.contents()).toEqual({ "chopin.exe": "old" });

		// With the target in place, its .old is the one a finished update leaves, and stays.
		let done = await folder({ "chopin.exe": "new", "chopin.exe.old": "old" });
		expect(await recover(done.target, { files, log: line => said.push(line) })).toBe(false);
		expect(await done.contents()).toEqual({ "chopin.exe": "new", "chopin.exe.old": "old" });
		expect(said.length).toBe(1);
	});

	test("on Windows, replaces a target left missing by an interrupted update", async () => {
		let at = await folder({ "chopin.exe.old": "old" });
		let said: string[] = [];
		await replace(at.target, new TextEncoder().encode("new"), {
			platform: "win32",
			log: line => said.push(line),
		});
		expect(said).toEqual([
			`Restored ${at.target} from ${at.target}.old, left by an update that was interrupted.`,
		]);
		expect(await at.contents()).toEqual({ "chopin.exe": "new", "chopin.exe.old": "old" });
	});

	test("on Windows, gives the command that restores the old binary when moving it back fails", async () => {
		let at = await folder({ "chopin.exe": "old" });
		let files = {
			...fs,
			rename: async (from: string, to: string) => {
				if (to === at.target) throw new Error(`EBUSY: cannot rename to ${to}`);
				await fs.rename(from, to);
			},
		};
		let error = await replace(at.target, new TextEncoder().encode("new"), {
			platform: "win32",
			files,
		})
			.then(() => undefined, (error: Error) => error);
		expect(error?.message).toContain(`move "${at.target}.old" "${at.target}"`);
		expect(error?.message).toContain("install.ps1");
		expect(await at.contents()).toEqual({ "chopin.exe.old": "old" });
	});
});
