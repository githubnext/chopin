import { expect, test } from "bun:test";
import "./isolated-git.test-fixtures";
import { createRequest, openResult, sealResult } from "./actions.mjs";

let key = "01234567890123456789012345678901";
let result = {
	repository: "githubnext/chopin",
	number: 123,
	attempt: "attempt-1",
	runId: "456",
	outcome: { kind: "applied", head: "abc" },
};

test("worker results authenticate PR, attempt, run, and repository before use", () => {
	let packet = sealResult(result, key);
	expect(openResult(packet, result, key)).toEqual(result.outcome);
	for (let changed of [{ number: 124 }, { attempt: "other" }, { runId: "457" }]) {
		expect(() => openResult(packet, { ...result, ...changed }, key)).toThrow();
	}
	packet.payload.prs["123"].outcome.head = "forged";
	expect(() => openResult(packet, result, key)).toThrow();
});

test("GitHub requests stay on the API host and never expose credentials or raw errors", async () => {
	let seen: { url: string; options: RequestInit }[] = [];
	let request = createRequest("private-token", async (url: string, options: RequestInit) => {
		seen.push({ url, options });
		return new Response(JSON.stringify({ message: "RAW_SECRET" }), { status: 409 });
	});
	try {
		await request("PUT", "/repos/githubnext/chopin/contents/state.json", { sha: "old" });
		throw new Error("Expected conflict");
	} catch (error) {
		expect((error as Error).message).toBe("GitHub request failed (HTTP 409)");
		expect((error as { status: number }).status).toBe(409);
	}
	expect(seen[0]!.url).toBe("https://api.github.com/repos/githubnext/chopin/contents/state.json");
	expect(seen[0]!.options.redirect).toBe("error");
	await expect(request("GET", "https://other.example/secret")).rejects.toThrow();
	expect(seen).toHaveLength(1);
	let offline = createRequest("private-token", async () => {
		throw new Error("private-token RAW_SECRET");
	});
	await expect(offline("GET", "/repos/githubnext/chopin")).rejects.toThrow(
		"GitHub request unavailable",
	);
});

test("publication uses the captured exact lease and rejects a newer branch tip", async () => {
	let { execFileSync } = await import("node:child_process");
	let { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	let { tmpdir } = await import("node:os");
	let { join } = await import("node:path");
	let { pushProposal, trustedGit } = await import("./actions.mjs");
	let root = mkdtempSync(join(tmpdir(), "maintenance-lease-"));
	let directory = join(root, "source");
	let remote = join(root, "remote.git");
	let git = (args: string[]) =>
		execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
	try {
		execFileSync("git", ["init", "--quiet", directory]);
		execFileSync("git", ["init", "--bare", "--quiet", remote]);
		git(["config", "user.name", "Fixture"]);
		git(["config", "user.email", "fixture@example.com"]);
		writeFileSync(join(directory, "file"), "initial");
		git(["add", "."]);
		git(["commit", "--quiet", "-m", "initial"]);
		let expectedHead = git(["rev-parse", "HEAD"]);
		git(["push", "--quiet", remote, "HEAD:refs/heads/pr"]);
		writeFileSync(join(directory, "file"), "fix");
		git(["commit", "--quiet", "-am", "fix"]);
		let proposalHead = git(["rev-parse", "HEAD"]);
		let run = (cwd: string, args: string[]) =>
			trustedGit(
				cwd,
				args.map((arg) => arg === "https://github.com/githubnext/chopin.git" ? remote : arg),
			);
		pushProposal(
			{ repository: "githubnext/chopin", directory, branch: "pr", expectedHead, proposalHead },
			"",
			run,
		);
		expect(git(["ls-remote", remote, "refs/heads/pr"]).split("\t")[0]).toBe(proposalHead);
		git(["commit", "--quiet", "--allow-empty", "-m", "human update"]);
		let newer = git(["rev-parse", "HEAD"]);
		git(["push", "--quiet", remote, "HEAD:refs/heads/pr"]);
		expect(() =>
			pushProposal(
				{
					repository: "githubnext/chopin",
					directory,
					branch: "pr",
					expectedHead: proposalHead,
					proposalHead: expectedHead,
				},
				"",
				run,
			)
		).toThrow("Trusted Git operation failed");
		expect(git(["ls-remote", remote, "refs/heads/pr"]).split("\t")[0]).toBe(newer);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
