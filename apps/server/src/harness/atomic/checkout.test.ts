import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedCheckout } from "./checkout";

let root = await mkdtemp(join(tmpdir(), "chopin-checkouts-"));
afterAll(() => rm(root, { recursive: true, force: true }));
let repository = { owner: "Octo-Org", name: "Score" };

async function checkout(name: string, origin: string) {
	let path = join(root, name);
	await mkdir(path);
	for (let args of [["init", "--quiet"], ["remote", "add", "origin", origin]]) {
		let process = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
		expect(await process.exited).toBe(0);
	}
	return path;
}

test("verifies origin owner/name for URL, SSH and alias checkouts, and nothing else", async () => {
	for (
		let [index, origin] of [
			"https://github.com/octo-org/score.git",
			"ssh://git@github.com/Octo-Org/Score",
			"git@github.com:octo-org/score.git",
			"workgit:octo-org/score.git",
		].entries()
	) {
		let path = await checkout(String(index), origin);
		expect(await verifiedCheckout(repository, path)).toBe(await realpath(path));
	}
	let mismatch = await checkout("mismatch", "https://github.com/other/score.git");
	for (let path of [mismatch, root, join(root, "missing")]) {
		expect(await verifiedCheckout(repository, path)).toBeUndefined();
	}
});
