import { expect, test } from "bun:test";
import "./isolated-git.test-fixtures";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProposal } from "./application.mjs";
import { begin, initialState } from "./state.mjs";

function fixture(
	protectedChange = false,
	contents = "repair",
	operation = "fix",
	baseExtraBytes = 0,
	baseRef = "main",
) {
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
	let root = git("rev-parse", "HEAD");
	let head = root;
	let expectedBase = root;
	if (baseRef === "parent") {
		git("checkout", "-qb", "parent");
		writeFileSync(join(source, "apps/a.ts"), "parent");
		git("add", ".");
		git("commit", "-qm", "parent");
		expectedBase = git("rev-parse", "HEAD");
		git("checkout", "-qb", "feature");
		writeFileSync(join(source, "apps/a.ts"), "child");
		git("add", ".");
		git("commit", "-qm", "child");
		head = git("rev-parse", "HEAD");
	}
	if (operation === "merge") {
		git("checkout", "-qb", "feature");
		writeFileSync(join(source, "apps/a.ts"), "feature");
		git("add", ".");
		git("commit", "-qm", "feature");
		head = git("rev-parse", "HEAD");
		git("checkout", "-qb", "main", root);
		writeFileSync(join(source, "apps/a.ts"), "base update");
		if (baseExtraBytes > 0) {
			writeFileSync(join(source, "apps/base-extra.ts"), "x".repeat(baseExtraBytes));
		}
		git("add", ".");
		git("commit", "-qm", "base update");
		expectedBase = git("rev-parse", "HEAD");
		git("checkout", "-q", "feature");
	}
	execFileSync("git", ["clone", "-q", source, directory]);
	if (operation === "merge") {
		expect(() => git("merge", "--no-ff", "--no-commit", "main")).toThrow();
	}
	writeFileSync(join(source, protectedChange ? "package.json" : "apps/a.ts"), contents);
	git("add", ".");
	git("commit", "-qm", "proposal");
	let proposalHead = git("rev-parse", "HEAD");
	let reviewBase = head;
	if (operation === "merge") {
		let output: string;
		try {
			output = execFileSync("git", [
				"merge-tree",
				"--write-tree",
				"-z",
				"--name-only",
				"--no-messages",
				head,
				expectedBase,
			], { cwd: source, encoding: "utf8" });
		} catch (error) {
			let failed = error as { status?: number; stdout?: string };
			if (failed.status !== 1 || typeof failed.stdout !== "string") throw error;
			output = failed.stdout;
		}
		reviewBase = output.split("\0")[0];
	}
	git("update-ref", "refs/pr-maintenance/proposal", proposalHead);
	git(
		"bundle",
		"create",
		join(artifactDirectory, "proposal.bundle"),
		"refs/pr-maintenance/proposal",
		`^${head}`,
		...(operation === "merge" ? [`^${expectedBase}`] : []),
	);
	let manifest = {
		schemaVersion: 1,
		attempt: "attempt",
		operation,
		pr: 1,
		expectedHead: head,
		expectedBase,
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
					initialState({
						number: 1,
						head,
						baseHead: expectedBase,
						action: operation === "merge"
							? "conflict"
							: operation === "rebase"
							? "rebase"
							: "repair",
					}, 1),
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
		base: { ref: baseRef, repo: { full_name: "owner/repo" } },
	};
	let calls: string[] = [];
	let baseHead = expectedBase;
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
			reviewBase,
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
		source,
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
}, 15_000);

test("guarded publication accepts one reviewed conflict merge and rejects stale base", async () => {
	let f = fixture(false, "combined", "merge");
	expect(await applyProposal(f.options)).toEqual({
		kind: "applied",
		head: f.proposalHead,
		verification: {
			head: f.proposalHead,
			operation: "merge",
			paths: ["apps/a.ts"],
			checks: [{ command: "bun test", result: "passed" }],
			hashReviews: [],
		},
	});
	expect(f.calls.indexOf("save")).toBeLessThan(f.calls.indexOf("push"));
	f = fixture(false, "combined", "merge");
	f.setBase("c".repeat(40));
	expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
	expect(f.calls).not.toContain("push");
	f = fixture(false, "combined", "merge");
	f.pr.head.sha = "c".repeat(40);
	expect(await applyProposal(f.options)).toEqual({ kind: "superseded" });
	expect(f.calls).not.toContain("push");
}, 15_000);

test("merge detector reviews only resolution over the synthetic merge tree", async () => {
	let f = fixture(false, "combined", "merge", 20 * 1024);
	let headDiff = execFileSync("git", ["diff", "--binary", f.head, f.proposalHead], {
		cwd: f.source,
	});
	expect(headDiff.length).toBeGreaterThan(10 * 1024);
	expect(Buffer.byteLength(f.options.review)).toBeLessThanOrEqual(10 * 1024);
	expect((await applyProposal(f.options)).kind).toBe("applied");
	let mismatch = fixture(false, "combined", "merge");
	mismatch.options.review = execFileSync("git", [
		"diff",
		"--binary",
		mismatch.head,
		mismatch.proposalHead,
	], { cwd: mismatch.source, encoding: "utf8" });
	expect((await applyProposal(mismatch.options)).kind).toBe("blocked");
	expect(mismatch.calls).not.toContain("save");
	expect(mismatch.calls).not.toContain("push");
}, 15_000);

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

test("stacked one-commit fix publishes after validating the recorded parent head", async () => {
	let f = fixture(false, "repair", "fix", 0, "parent");
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
}, 15_000);

test(
	"stacked fixes reject stale parent heads and protected changes before publication",
	async () => {
		let stale = fixture(false, "repair", "fix", 0, "parent");
		stale.setBase("c".repeat(40));
		expect(await applyProposal(stale.options)).toEqual({ kind: "superseded" });
		expect(stale.calls).not.toContain("save");
		expect(stale.calls).not.toContain("push");
		let raced = fixture(false, "repair", "fix", 0, "parent");
		let save = raced.options.store.save;
		raced.options.store.save = async (previous, next) => {
			let saved = await save(previous, next);
			raced.setBase("c".repeat(40));
			return saved;
		};
		expect(await applyProposal(raced.options)).toEqual({ kind: "superseded" });
		expect(raced.calls).not.toContain("push");
		let protectedChange = fixture(true, "changed", "fix", 0, "parent");
		expect((await applyProposal(protectedChange.options)).kind).toBe("blocked");
		expect(protectedChange.calls).not.toContain("save");
		expect(protectedChange.calls).not.toContain("push");
		let unreviewed = fixture(false, "repair", "fix", 0, "parent");
		unreviewed.options.review = "unreviewed";
		expect((await applyProposal(unreviewed.options)).kind).toBe("blocked");
		expect(unreviewed.calls).not.toContain("save");
		expect(unreviewed.calls).not.toContain("push");
	},
	15_000,
);

test("stacked merge and rebase remain blocked without a trusted replay boundary", async () => {
	for (let operation of ["merge", "rebase"]) {
		let f = operation === "merge"
			? fixture(false, "combined", operation)
			: fixture(false, "repair", operation, 0, "parent");
		f.pr.base.ref = "parent";
		expect(await applyProposal(f.options)).toEqual({
			kind: "blocked",
			reason: "Stacked PR needs a recorded trusted replay boundary",
		});
		expect(f.calls).not.toContain("save");
		expect(f.calls).not.toContain("push");
	}
}, 15_000);

test("post-registration opt-out supersedes", async () => {
	let f = fixture();
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

test("review over the safe-output limit blocks before state writes", async () => {
	let f = fixture(false, "x".repeat(10 * 1024));
	expect(Buffer.byteLength(f.options.review)).toBeGreaterThan(10 * 1024);
	expect(Buffer.byteLength(f.options.review)).toBeLessThan(11 * 1024);
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
