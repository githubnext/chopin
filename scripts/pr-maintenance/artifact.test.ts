import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProposal } from "./artifact.mjs";

function fixture() {
	let directory = mkdtempSync(join(tmpdir(), "artifact-"));
	let git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		}).trim();
	git("init", "-q");
	writeFileSync(join(directory, "a"), "a");
	git("add", ".");
	git("commit", "-qm", "initial");
	let head = git("rev-parse", "HEAD");
	git("update-ref", "refs/pr-maintenance/proposal", head);
	git("bundle", "create", "proposal.bundle", "refs/pr-maintenance/proposal");
	let expected = {
		attempt: "attempt",
		operation: "fix",
		pr: 1,
		expectedHead: head,
		expectedBase: head,
		oldReplayBoundary: null,
	};
	let manifest = {
		schemaVersion: 1,
		...expected,
		proposalHead: head,
		bundleSha256: createHash("sha256").update(readFileSync(join(directory, "proposal.bundle")))
			.digest("hex"),
		checks: [{ command: "bun test", result: "passed" }],
		hashReviews: [],
	};
	let save = () => writeFileSync(join(directory, "proposal.json"), JSON.stringify(manifest));
	save();
	return { directory, git, head, expected, manifest, save };
}

test("reads a bound real Git bundle and rejects authority/checksum/schema changes", () => {
	let f = fixture();
	expect(readProposal(f.directory, f.expected).manifest.proposalHead).toBe(f.head);
	for (
		let change of [{ attempt: "other" }, { bundleSha256: "0".repeat(64) }, { extra: true }, {
			checks: [],
		}]
	) {
		let original = { ...f.manifest };
		Object.assign(f.manifest, change);
		writeFileSync(join(f.directory, "proposal.json"), JSON.stringify(f.manifest));
		expect(() => readProposal(f.directory, f.expected)).toThrow();
		f.manifest = original;
		writeFileSync(join(f.directory, "proposal.json"), JSON.stringify(original));
	}
});

test("rejects symlink artifacts, oversized JSON, and extra bundle refs", () => {
	let f = fixture();
	rmSync(join(f.directory, "proposal.json"));
	symlinkSync(join(f.directory, "a"), join(f.directory, "proposal.json"));
	expect(() => readProposal(f.directory, f.expected)).toThrow();
	rmSync(join(f.directory, "proposal.json"));
	writeFileSync(join(f.directory, "proposal.json"), " ".repeat(256 * 1024 + 1));
	expect(() => readProposal(f.directory, f.expected)).toThrow();
	f.git("bundle", "create", "proposal.bundle", "--all");
	f.manifest.bundleSha256 = createHash("sha256").update(
		readFileSync(join(f.directory, "proposal.bundle")),
	).digest("hex");
	f.save();
	expect(() => readProposal(f.directory, f.expected)).toThrow();
});

test("rejects a wrong proposal SHA, wrong replay boundary, and bundle symlink", () => {
	let f = fixture();
	let original = { ...f.manifest };
	for (let change of [{ proposalHead: "a".repeat(40) }, { oldReplayBoundary: f.head }]) {
		writeFileSync(join(f.directory, "proposal.json"), JSON.stringify({ ...original, ...change }));
		expect(() => readProposal(f.directory, f.expected)).toThrow();
	}
	writeFileSync(join(f.directory, "proposal.json"), JSON.stringify(original));
	rmSync(join(f.directory, "proposal.bundle"));
	symlinkSync(join(f.directory, "a"), join(f.directory, "proposal.bundle"));
	expect(() => readProposal(f.directory, f.expected)).toThrow();
});
