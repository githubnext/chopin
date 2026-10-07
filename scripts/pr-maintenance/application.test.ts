import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProposal } from "./application.mjs";
import { begin, initialState } from "./state.mjs";

function fixture(protectedChange = false, contents = "repair") {
	let source = mkdtempSync(join(tmpdir(), "application-source-"));
	let directory = mkdtempSync(join(tmpdir(), "application-trusted-"));
	let artifactDirectory = mkdtempSync(join(tmpdir(), "application-artifact-"));
	let git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: source,
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
	mkdirSync(join(source, "apps"));
	writeFileSync(join(source, "apps/a.ts"), "initial");
	git("add", ".");
	git("commit", "-qm", "base");
	let head = git("rev-parse", "HEAD");
	execFileSync("git", ["clone", "-q", source, directory]);
	writeFileSync(join(source, protectedChange ? "package.json" : "apps/a.ts"), contents);
	git("add", ".");
	git("commit", "-qm", "proposal");
	let proposalHead = git("rev-parse", "HEAD");
	git("update-ref", "refs/pr-maintenance/proposal", proposalHead);
	git(
		"bundle",
		"create",
		join(artifactDirectory, "proposal.bundle"),
		"refs/pr-maintenance/proposal",
		`^${head}`,
	);
	let manifest = {
		schemaVersion: 1,
		attempt: "attempt",
		operation: "fix",
		pr: 1,
		expectedHead: head,
		expectedBase: head,
		proposalHead,
		oldReplayBoundary: null,
		bundleSha256: createHash("sha256").update(
			readFileSync(join(artifactDirectory, "proposal.bundle")),
		).digest("hex"),
		checks: [{ command: "bun test", result: "passed" }],
		hashReviews: [],
	};
	writeFileSync(join(artifactDirectory, "proposal.json"), JSON.stringify(manifest));
	let record = {
		sha: "a".repeat(40),
		payload: {
			schemaVersion: 1,
			repository: "owner/repo",
			revision: 0,
			prs: {
				"1": begin(
					initialState({ number: 1, head, baseHead: head, action: "repair" }, 1),
					"attempt",
					2,
				),
			},
		},
	};
	let pr = {
		state: "open",
		labels: [],
		head: { sha: head, ref: "feature", repo: { full_name: "owner/repo" } },
		base: { ref: "main", repo: { full_name: "owner/repo" } },
	};
	let calls: string[] = [];
	let baseHead = head;
	let store = {
		async load() {
			calls.push("load");
			return structuredClone(record);
		},
		async save(previous: typeof record, next: typeof record.payload) {
			calls.push("save");
			expect(previous.payload.revision + 1).toBe(next.revision);
			record = { sha: "b".repeat(40), payload: structuredClone(next) };
			return structuredClone(record);
		},
	};
	let options = {
		repository: "owner/repo",
		number: 1,
		attempt: "attempt",
		store,
		directory,
		artifactDirectory,
		review: execFileSync("git", [
			"--no-replace-objects",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--binary",
			head,
			proposalHead,
		], { cwd: source, encoding: "utf8" }),
		now: 3,
		async request(_method: string, path: string) {
			calls.push(path);
			return path.endsWith("/pulls/1") ? structuredClone(pr) : { commit: { sha: baseHead } };
		},
		async push(value: { expectedHead: string; proposalHead: string; branch: string }) {
			calls.push("push");
			expect(record.payload.prs["1"].active!.proposalHead).toBe(proposalHead);
			expect(value.expectedHead).toBe(head);
			expect(value.branch).toBe("feature");
			pr.head.sha = value.proposalHead;
		},
	};
	return {
		options,
		calls,
		pr,
		head,
		proposalHead,
		record: () => record,
		setBase: (value: string) => {
			baseHead = value;
		},
	};
}

test("registers using CAS before guarded push and verifies published head", async () => {
	let f = fixture();
	expect(await applyProposal(f.options)).toEqual({
		kind: "applied",
		head: f.proposalHead,
		verification: {
			head: f.proposalHead,
			operation: "fix",
			paths: ["apps/a.ts"],
			checks: [{ command: "bun test", result: "passed" }],
			hashReviews: [],
		},
	});
	expect(f.calls.indexOf("save")).toBeLessThan(f.calls.indexOf("push"));
	expect(await applyProposal(f.options)).toEqual({
		kind: "applied",
		head: f.proposalHead,
		verification: {
			head: f.proposalHead,
			operation: "fix",
			paths: ["apps/a.ts"],
			checks: [{ command: "bun test", result: "passed" }],
			hashReviews: [],
		},
	});
	expect(f.calls.filter((call) => call === "push")).toHaveLength(1);
});

test("head/base drift and opt-out supersede without publication", async () => {
	for (let drift of ["head", "base", "opt-out"]) {
		let f = fixture();
		if (drift === "head") f.pr.head.sha = "c".repeat(40);
		if (drift === "base") f.setBase("c".repeat(40));
		if (drift === "opt-out") (f.pr.labels as { name: string }[]).push({ name: "no-babysit" });
		expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
		expect(f.calls).not.toContain("save");
		expect(f.calls).not.toContain("push");
	}
});

test("blocks protected changes and exact detector review mismatch before writes", async () => {
	for (let protectedChange of [true, false]) {
		let f = fixture(protectedChange);
		if (!protectedChange) f.options.review = "I reviewed the changes";
		expect((await applyProposal(f.options)).kind).toBe("blocked");
		expect(f.calls).not.toContain("save");
		expect(f.calls).not.toContain("push");
	}
});

test("missing or empty proposal review cannot authorize a nonempty Git diff", async () => {
	for (let review of [undefined, "", "incorrect review"]) {
		let f = fixture();
		expect(f.options.review.length).toBeGreaterThan(0);
		expect((await applyProposal({ ...f.options, review })).kind).toBe("blocked");
		expect(f.calls).not.toContain("save");
		expect(f.calls).not.toContain("push");
	}
});

test("CAS failure prevents push and does not leak infrastructure errors", async () => {
	let f = fixture();
	f.options.store.save = async () => {
		throw new Error("secret provider response");
	};
	await expect(applyProposal(f.options)).rejects.toThrow("Proposal registration failed");
	expect(f.calls).not.toContain("push");
});

test("rechecks signed state and base immediately before push", async () => {
	for (let race of ["base", "episode"]) {
		let f = fixture();
		let save = f.options.store.save;
		f.options.store.save = async (previous, next) => {
			let saved = await save(previous, next);
			if (race === "base") f.setBase("c".repeat(40));
			else f.record().payload.prs["1"].episode++;
			return saved;
		};
		expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
		expect(f.calls).not.toContain("push");
	}
});

test("unexpected published head supersedes; crash after push recovers without repush", async () => {
	let f = fixture();
	f.options.push = async () => {
		f.calls.push("push");
		f.pr.head.sha = "c".repeat(40);
	};
	expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
	f = fixture();
	f.options.push = async () => {
		f.calls.push("push");
		f.pr.head.sha = f.proposalHead;
		throw new Error("secret");
	};
	await expect(applyProposal(f.options)).rejects.toThrow("Proposal push failed");
	expect(await applyProposal(f.options)).toEqual({
		kind: "applied",
		head: f.proposalHead,
		verification: {
			head: f.proposalHead,
			operation: "fix",
			paths: ["apps/a.ts"],
			checks: [{ command: "bun test", result: "passed" }],
			hashReviews: [],
		},
	});
	expect(f.calls.filter((call) => call === "push")).toHaveLength(1);
});

test("main-only rollout blocks stacks, and post-registration opt-out supersedes", async () => {
	let f = fixture();
	f.pr.base.ref = "parent";
	expect(await applyProposal(f.options)).toEqual({
		kind: "blocked",
		reason: "Stacked PR needs a recorded trusted replay boundary",
	});
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
	f = fixture();
	let save = f.options.store.save;
	f.options.store.save = async (previous, next) => {
		let saved = await save(previous, next);
		(f.pr.labels as { name: string }[]).push({ name: "no-babysit" });
		return saved;
	};
	expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
	expect(f.calls).not.toContain("push");
});

test("recovery still validates the artifact and rejects base drift", async () => {
	let f = fixture();
	expect((await applyProposal(f.options)).kind).toBe("applied");
	f.options.review = "unbound";
	expect((await applyProposal(f.options)).kind).toBe("blocked");
	f.setBase("c".repeat(40));
	expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
	expect(f.calls.filter((call) => call === "push")).toHaveLength(1);
});

test("missing Git executable is sanitized infrastructure failure, not a policy blocker", async () => {
	let f = fixture();
	let previous = process.env.PATH;
	try {
		process.env.PATH = "/nonexistent-pr-maintenance-test-bin";
		await expect(applyProposal(f.options)).rejects.toThrow(
			"Proposal validation infrastructure failed",
		);
	} finally {
		process.env.PATH = previous;
	}
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
});

test("real Git import ref-lock failure stays sanitized infrastructure failure", async () => {
	let f = fixture();
	mkdirSync(join(f.options.directory, ".git/refs/pr-maintenance"), { recursive: true });
	writeFileSync(join(f.options.directory, ".git/refs/pr-maintenance/proposal.lock"), "held lock");
	await expect(applyProposal(f.options)).rejects.toThrow(
		"Proposal validation infrastructure failed",
	);
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
});

test("missing captured object is a trusted repository infrastructure failure", async () => {
	let f = fixture();
	let missing = "f".repeat(40);
	let state = f.record().payload.prs["1"];
	state.head = missing;
	state.baseHead = missing;
	state.active!.head = missing;
	state.active!.baseHead = missing;
	f.pr.head.sha = missing;
	f.setBase(missing);
	await expect(applyProposal(f.options)).rejects.toThrow(
		"Proposal validation infrastructure failed",
	);
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
});

test("compressible oversized proposal diff is a policy blocker before state writes", async () => {
	let f = fixture(false, "x".repeat(512 * 1024));
	expect(await applyProposal(f.options)).toEqual({
		kind: "blocked",
		reason: "Detector review must exactly match the bounded proposal diff",
	});
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
});

test("malformed verification records block before registration or publication", async () => {
	let f = fixture();
	let manifestPath = join(f.options.artifactDirectory, "proposal.json");
	let manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.hashReviews = [{ file: "apps/a.ts", sourceHash: "invalid", rationale: "reviewed" }];
	writeFileSync(manifestPath, JSON.stringify(manifest));
	expect((await applyProposal(f.options)).kind).toBe("blocked");
	expect(f.calls).not.toContain("save");
	expect(f.calls).not.toContain("push");
});
