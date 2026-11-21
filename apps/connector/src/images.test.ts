import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageKey, type ImageRecipe, installInputs } from "./images";

let scratch = await mkdtemp(join(tmpdir(), "chopin-images-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

let made = 0;
/** A folder of `files`, by path inside it, each with its content, and executable when it says. */
async function folder(files: Record<string, string | { content: string; executable: true }>) {
	let root = join(scratch, `folder-${made++}`);
	await mkdir(root, { mode: 0o700 });
	for (let [path, file] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true, mode: 0o700 });
		let content = typeof file === "string" ? file : file.content;
		await writeFile(join(root, path), content, { mode: typeof file === "string" ? 0o600 : 0o700 });
	}
	return root;
}

const RECIPE: ImageRecipe = {
	name: "pdd",
	install: ["npm install -g /install-from/agent.tgz"],
	programs: ["agent"],
};
const USER = { uid: 1000, gid: 1000 };
const LAYER = "11111111-2222-4333-8444-555555555555";

describe("the folder --install-from names", () => {
	test("an image is built again when a file in it changes, is added or becomes executable", async () => {
		let key = async (files: Parameters<typeof folder>[0]) =>
			imageKey(RECIPE, LAYER, USER, await installInputs(await folder(files)));
		let first = await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1" });
		expect(await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1" })).toBe(first);
		expect(await key({ "agent.tgz": "release 2", "deps/natives.tgz": "natives 1" })).not.toBe(
			first,
		);
		expect(
			await key({ "agent.tgz": "release 1", "deps/natives.tgz": "natives 1", "extra.tgz": "x" }),
		).not.toBe(first);
		expect(
			await key({
				"agent.tgz": { content: "release 1", executable: true },
				"deps/natives.tgz": "natives 1",
			}),
		).not.toBe(first);
		// A file moved to another folder is another input.
		expect(await key({ "agent.tgz": "release 1", "natives.tgz": "natives 1" })).not.toBe(first);
	});

	test("the build gets a copy anyone may read, of exactly what the key was made of", async () => {
		let source = await folder({
			"agent.tgz": "release 1",
			"bin/setup": { content: "#!/bin/sh\n", executable: true },
		});
		let copy = join(scratch, "copy");
		await mkdir(copy);
		expect(await installInputs(source, copy)).toBe(await installInputs(source));
		expect(await Bun.file(join(copy, "agent.tgz")).text()).toBe("release 1");
		let mode = async (path: string) => (await stat(join(copy, path))).mode & 0o777;
		// The person's folder is theirs alone (0700); the build's nobody reads the copy.
		expect(await mode("agent.tgz")).toBe(0o644);
		expect(await mode("bin")).toBe(0o755);
		expect(await mode("bin/setup")).toBe(0o755);
	});

	test("a link in it is refused rather than followed to what it names on the host", async () => {
		let source = await folder({ "agent.tgz": "release 1" });
		await symlink("/etc/passwd", join(source, "passwd"));
		await chmod(source, 0o700);
		await expect(installInputs(source)).rejects.toThrow(
			`${
				join(source, "passwd")
			} isn't a file or a folder, and an image's build is given only those.`,
		);
	});
});
