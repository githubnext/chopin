import { expect, test } from "bun:test";
import "./isolated-git.test-fixtures";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { validateProposal } from "./proposal.mjs";

function fixture() {
	let directory = mkdtempSync(join(tmpdir(), "proposal-"));
	let git = (...args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: directory,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Original",
				GIT_AUTHOR_EMAIL: "original@example.com",
				GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
				GIT_COMMITTER_NAME: "Bot",
				GIT_COMMITTER_EMAIL: "bot@example.com",
				GIT_COMMITTER_DATE: "2026-01-02T12:00:00Z",
			},
		}).trim();
	let put = (path: string, value: string) => {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), value);
	};
	let commit = (message = "change") => {
		git("add", ".");
		git("commit", "-m", message);
		return git("rev-parse", "HEAD");
	};
	git("init", "-q");
	put("apps/a.ts", "initial");
	put(".github/workflows/ci.yml", "initial");
	let base = commit("base");
	return { directory, git, put, commit, base };
}
function fix(f: ReturnType<typeof fixture>, head: string, proposal: string) {
	return validateProposal({
		directory: f.directory,
		operation: "fix",
		expectedHead: head,
		expectedBase: f.base,
		proposalHead: proposal,
	});
}

test("accepts one linear repair; rejects nested policies and external symlinks", () => {
	let f = fixture();
	f.put("apps/a.ts", "repair");
	let p = f.commit();
	expect(fix(f, f.base, p).paths).toEqual(["apps/a.ts"]);
	for (let path of ["apps/nested/package.json", "packages/nested/AGENTS.md"]) {
		f.git("reset", "--hard", f.base);
		f.put(path, "{}");
		expect(() => fix(f, f.base, f.commit())).toThrow("Protected");
	}
	f.git("reset", "--hard", f.base);
	symlinkSync("/etc/passwd", join(f.directory, "apps/link"));
	expect(() => fix(f, f.base, f.commit())).toThrow("regular");
});

test("rejects divergent, empty, and multi-commit fixes", () => {
	let f = fixture();
	expect(() => fix(f, f.base, f.base)).toThrow();
	f.put("apps/a.ts", "one");
	let h = f.commit();
	f.put("apps/a.ts", "two");
	let p = f.commit();
	expect(() => fix(f, f.base, p)).toThrow();
	f.git("checkout", "--detach", f.base);
	f.put("apps/a.ts", "other");
	expect(() => fix(f, h, f.commit())).toThrow();
});

test("fixes current-head CI without rebasing a mergeable behind branch", () => {
	let f = fixture();
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature");
	f.git("checkout", "--detach", f.base);
	f.put("apps/b.ts", "base update");
	let base = f.commit("base update");
	f.git("checkout", "--detach", head);
	f.put("apps/a.ts", "feature repaired");
	let proposal = f.commit("repair");
	expect(
		validateProposal({
			directory: f.directory,
			operation: "fix",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
		}).paths,
	).toEqual(["apps/a.ts"]);
});

test("merge preserves an existing merge history and both captured parents", () => {
	let f = fixture();
	f.put("apps/a.ts", "first");
	let first = f.commit("feature first");
	f.git("checkout", "--detach", f.base);
	f.put("apps/base.ts", "first base");
	let oldBase = f.commit("old base");
	f.git("checkout", "--detach", first);
	f.git("merge", "--no-ff", "-m", "prior merge", oldBase);
	let head = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach", oldBase);
	f.put("apps/a.ts", "new base");
	let base = f.commit("new base");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put("apps/a.ts", "combined");
	let proposal = f.commit("resolve conflict");
	let validate = (p = proposal, h = head, b = base) =>
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: h,
			expectedBase: b,
			proposalHead: p,
		});
	expect(validate().paths).toEqual(["apps/a.ts"]);
	expect(() => validate(proposal, base, head)).toThrow("parents");
	expect(() => validate(proposal, head, oldBase)).toThrow("parents");
});

test("merge blocks a protected conflict even when the chosen tree matches one side", () => {
	let f = fixture();
	f.put(".github/workflows/ci.yml", "feature");
	let head = f.commit("feature");
	f.git("checkout", "--detach", f.base);
	f.put(".github/workflows/ci.yml", "base");
	let base = f.commit("base update");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put(".github/workflows/ci.yml", "feature");
	let proposal = f.commit("resolve");
	expect(() =>
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
		})
	).toThrow("Protected conflict");
});

test("merge cannot silently discard the base side of an overlapping repair path", () => {
	let f = fixture();
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature");
	f.git("checkout", "--detach", f.base);
	f.put("apps/a.ts", "base update");
	let base = f.commit("base update");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put("apps/a.ts", "feature");
	let proposal = f.commit("keep feature");
	expect(() =>
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
		})
	).toThrow("silently retain");
});

test("merge-tree names every conflicted path in its machine output", () => {
	let f = fixture();
	f.put("apps/b.ts", "initial");
	let root = f.commit("second path");
	f.put("apps/a.ts", "head a");
	f.put("apps/b.ts", "head b");
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	f.put("apps/a.ts", "base a");
	f.put("apps/b.ts", "base b");
	let base = f.commit("base");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put("apps/a.ts", "resolved a");
	f.put("apps/b.ts", "resolved b");
	let proposal = f.commit("resolve both");
	expect(
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
		}).paths,
	).toEqual(["apps/a.ts", "apps/b.ts"]);
});

test("merge rejects extra edits to an otherwise unconflicted repair file", () => {
	let f = fixture();
	let lines = [
		"first",
		"middle1",
		"middle2",
		"middle3",
		"middle4",
		"middle5",
		"middle6",
		"middle7",
		"last",
	];
	f.put("apps/b.ts", lines.join("\n") + "\n");
	let root = f.commit("second file");
	f.put("apps/a.ts", "feature");
	f.put("apps/b.ts", ["head", ...lines.slice(1)].join("\n") + "\n");
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	f.put("apps/a.ts", "base");
	f.put("apps/b.ts", [...lines.slice(0, -1), "base"].join("\n") + "\n");
	let base = f.commit("base");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put("apps/a.ts", "combined");
	let proposal = f.commit("resolve");
	let options = {
		directory: f.directory,
		operation: "merge",
		expectedHead: head,
		expectedBase: base,
	};
	expect(validateProposal({ ...options, proposalHead: proposal }).paths).toEqual(["apps/a.ts"]);
	f.put("apps/b.ts", ["head", ...lines.slice(1)].join("\n") + "\n");
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(() =>
		validateProposal({
			...options,
			proposalHead: f.git("rev-parse", "HEAD"),
		})
	).toThrow("nonconflicting");
});

test("conflict operation refuses a clean merge-tree result", () => {
	let f = fixture();
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature");
	f.git("checkout", "--detach", f.base);
	f.put("apps/b.ts", "base");
	let base = f.commit("base");
	f.git("checkout", "--detach", head);
	f.git("merge", "--no-ff", "-m", "unneeded merge", base);
	expect(() =>
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: f.git("rev-parse", "HEAD"),
		})
	).toThrow("no unambiguous text conflict");
});

test("merge preserves a clean base hunk outside a conflict in the same file", () => {
	let f = fixture();
	let lines = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`);
	f.put("apps/a.ts", lines.join("\n") + "\n");
	let root = f.commit("long source");
	let ours = [...lines];
	ours[4] = "feature conflict";
	f.put("apps/a.ts", ours.join("\n") + "\n");
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	let theirs = [...lines];
	theirs[4] = "base conflict";
	theirs[16] = "base clean hunk";
	f.put("apps/a.ts", theirs.join("\n") + "\n");
	let base = f.commit("base");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	let resolved = [...theirs];
	resolved[4] = "combined conflict";
	f.put("apps/a.ts", resolved.join("\n") + "\n");
	let proposal = f.commit("resolve");
	let options = {
		directory: f.directory,
		operation: "merge",
		expectedHead: head,
		expectedBase: base,
	};
	expect(validateProposal({ ...options, proposalHead: proposal }).paths).toEqual(["apps/a.ts"]);
	resolved[16] = "line 17";
	f.put("apps/a.ts", resolved.join("\n") + "\n");
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(() =>
		validateProposal({
			...options,
			proposalHead: f.git("rev-parse", "HEAD"),
		})
	).toThrow("outside conflict markers");
});

test("merge refuses multiple valid merge bases", () => {
	let f = fixture();
	f.put("apps/a.ts", "A");
	let a = f.commit("A");
	f.git("checkout", "--detach", f.base);
	f.put("apps/b.ts", "B");
	let b = f.commit("B");
	f.git("checkout", "--detach", a);
	f.git("merge", "--no-ff", "-m", "A merges B", b);
	let head = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach", b);
	f.git("merge", "--no-ff", "-m", "B merges A", a);
	let base = f.git("rev-parse", "HEAD");
	let tree = f.git("rev-parse", `${head}^{tree}`);
	let proposal = f.git("commit-tree", tree, "-p", head, "-p", base, "-m", "merge");
	expect(() =>
		validateProposal({
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
		})
	).toThrow("Ambiguous merge boundary");
});

test("merge renews an existing design hash only with matching source and review", () => {
	let f = fixture();
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	let hash = (value: string) => createHash("sha256").update(value).digest("hex");
	let entry = { file: "apps/a.ts", sourceHash: hash("initial"), reason: "existing" };
	f.put(path, JSON.stringify([entry]));
	let root = f.commit("exception");
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	f.put("apps/a.ts", "base update");
	let base = f.commit("base update");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	f.put("apps/a.ts", "combined");
	f.put(path, JSON.stringify([{ ...entry, sourceHash: hash("combined") }]));
	let proposal = f.commit("resolve and renew");
	let options = {
		directory: f.directory,
		operation: "merge",
		expectedHead: head,
		expectedBase: base,
		proposalHead: proposal,
	};
	expect(() => validateProposal(options)).toThrow("review");
	expect(
		validateProposal({
			...options,
			hashReviews: [{
				file: "apps/a.ts",
				sourceHash: hash("combined"),
				rationale: "The existing exception still covers this source after the merge",
			}],
		}).paths,
	).toEqual(["apps/a.ts", path]);
});

function hashConflictFixture(baseReason = "existing", bothAddEntry = false) {
	let f = fixture();
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	let hash = (value: string) => createHash("sha256").update(value).digest("hex");
	f.put("apps/b.ts", "initial b");
	if (bothAddEntry) f.put("apps/c.ts", "source c");
	let entries = [
		{
			file: "apps/a.ts",
			reason: "existing",
			cases: [["dynamic", "class"]],
			sourceHash: hash("initial"),
		},
		{
			file: "apps/b.ts",
			reason: "existing",
			cases: [["dynamic", "class"]],
			sourceHash: hash("initial b"),
		},
	];
	f.put(path, JSON.stringify(entries));
	let root = f.commit("existing exceptions");
	let newEntry = {
		file: "apps/c.ts",
		reason: "new exception",
		cases: [["dynamic", "class"]],
		sourceHash: hash("source c"),
	};
	f.put("apps/a.ts", "head a");
	f.put(
		path,
		JSON.stringify([
			{ ...entries[0], sourceHash: hash("head a") },
			entries[1],
			...(bothAddEntry ? [newEntry] : []),
		]),
	);
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	f.put("apps/b.ts", "base b");
	f.put(
		path,
		JSON.stringify([
			entries[0],
			{ ...entries[1], reason: baseReason, sourceHash: hash("base b") },
			...(bothAddEntry ? [newEntry] : []),
		]),
	);
	let base = f.commit("base update");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	let proposalEntries = [
		{ ...entries[0], sourceHash: hash("head a") },
		{ ...entries[1], sourceHash: hash("base b") },
		...(bothAddEntry ? [newEntry] : []),
	];
	f.put(path, JSON.stringify(proposalEntries));
	let proposal = f.commit("merge reviewed hashes");
	let options = {
		directory: f.directory,
		operation: "merge",
		expectedHead: head,
		expectedBase: base,
		proposalHead: proposal,
		hashReviews: [
			{ file: "apps/a.ts", sourceHash: hash("head a"), rationale: "Existing exception preserved" },
			{ file: "apps/b.ts", sourceHash: hash("base b"), rationale: "Existing exception preserved" },
		],
	};
	return { ...f, path, options, proposalEntries };
}

test("merge resolves a protected design hash conflict with exact source reviews", () => {
	let f = hashConflictFixture();
	expect(validateProposal(f.options).paths).toEqual([f.path]);
	expect(() => validateProposal({ ...f.options, hashReviews: [] })).toThrow("review");
	expect(() =>
		validateProposal({
			...f.options,
			hashReviews: f.options.hashReviews.slice(1),
		})
	).toThrow("review");
	let entries = [
		f.proposalEntries[0],
		{ ...f.proposalEntries[1], sourceHash: "a".repeat(64) },
	];
	f.put(f.path, JSON.stringify(entries));
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(() =>
		validateProposal({
			...f.options,
			proposalHead: f.git("rev-parse", "HEAD"),
		})
	).toThrow("sourceHash does not match");
});

test("merge rejects design hash conflicts that alter structure or file mode", () => {
	let f = hashConflictFixture("base changed reason");
	expect(() => validateProposal(f.options)).toThrow("beyond sourceHash");
	f = hashConflictFixture("existing", true);
	expect(() => validateProposal(f.options)).toThrow("entry count changed");
	f = hashConflictFixture();
	for (
		let entries of [
			[{ ...f.proposalEntries[0], reason: "broadened" }, f.proposalEntries[1]],
			[{ ...f.proposalEntries[0], cases: [["dynamic", "different"]] }, f.proposalEntries[1]],
			[...f.proposalEntries, { ...f.proposalEntries[0], file: "apps/new.ts" }],
		]
	) {
		f.git("reset", "--hard", f.options.proposalHead);
		f.put(f.path, JSON.stringify(entries));
		f.git("add", ".");
		f.git("commit", "--amend", "--no-edit");
		expect(() =>
			validateProposal({
				...f.options,
				proposalHead: f.git("rev-parse", "HEAD"),
			})
		).toThrow();
	}
	f.git("reset", "--hard", f.options.proposalHead);
	f.git("update-index", "--chmod=+x", f.path);
	f.git("commit", "--amend", "--no-edit");
	expect(() =>
		validateProposal({
			...f.options,
			proposalHead: f.git("rev-parse", "HEAD"),
		})
	).toThrow("mode");
});

function discardedBaseHashFixture(mixed: boolean) {
	let f = fixture();
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	let hash = (value: string) => createHash("sha256").update(value).digest("hex");
	f.put("apps/b.ts", "initial b");
	let entries = [
		{ file: "apps/a.ts", reason: "existing", sourceHash: hash("initial") },
		{ file: "apps/b.ts", reason: "existing", sourceHash: hash("initial b") },
	];
	f.put(path, JSON.stringify(entries));
	let root = f.commit("exceptions");
	f.put("apps/a.ts", "head a");
	f.put(path, JSON.stringify([{ ...entries[0], sourceHash: hash("head a") }, entries[1]]));
	let head = f.commit("feature");
	f.git("checkout", "--detach", root);
	if (mixed) f.put("apps/a.ts", "base a");
	f.put(
		path,
		JSON.stringify([
			mixed ? { ...entries[0], sourceHash: hash("base a") } : entries[0],
			{ ...entries[1], sourceHash: hash("stale b") },
		]),
	);
	let base = f.commit("base");
	f.git("checkout", "--detach", head);
	expect(() => f.git("merge", "--no-ff", "--no-commit", base)).toThrow();
	if (mixed) f.put("apps/a.ts", "combined a");
	let proposed = [
		{ ...entries[0], sourceHash: hash(mixed ? "combined a" : "head a") },
		entries[1],
	];
	f.put(path, JSON.stringify(proposed, null, mixed ? 0 : 2));
	let proposal = f.commit("merge");
	return {
		...f,
		options: {
			directory: f.directory,
			operation: "merge",
			expectedHead: head,
			expectedBase: base,
			proposalHead: proposal,
			hashReviews: [
				{ file: "apps/a.ts", sourceHash: proposed[0].sourceHash, rationale: "Existing exception" },
				{ file: "apps/b.ts", sourceHash: proposed[1].sourceHash, rationale: "Existing exception" },
			],
		},
	};
}

test("protected hash conflict rejects semantic head-only and partially head-only resolutions", () => {
	for (let mixed of [false, true]) {
		let f = discardedBaseHashFixture(mixed);
		expect(() => validateProposal(f.options)).toThrow("silently retain head hash");
	}
});

function rebaseFixture(baseExtraBytes = 0) {
	let f = fixture();
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature message");
	f.git("checkout", "--detach", f.base);
	f.put(".github/workflows/ci.yml", "base update" + "x".repeat(baseExtraBytes));
	let base = f.commit("base update");
	f.git("cherry-pick", head);
	let proposal = f.git("rev-parse", "HEAD");
	let validate = (p = proposal, boundary: string | null = null) =>
		validateProposal({
			directory: f.directory,
			operation: "rebase",
			expectedHead: head,
			expectedBase: base,
			proposalHead: p,
			oldReplayBoundary: boundary,
		});
	return { ...f, head, newBase: base, proposal, validate };
}

test("rebase review excludes inherited base changes and includes agent edits", () => {
	let f = rebaseFixture(20 * 1024);
	let baseline = f.validate().reviewBase;
	expect(f.git("diff", "--binary", f.head, f.proposal).length).toBeGreaterThan(10 * 1024);
	expect(f.git("diff", "--binary", baseline, f.proposal)).toBe("");
	f.put("apps/a.ts", "agent edit");
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	let edited = f.git("rev-parse", "HEAD");
	let guarded = f.validate(edited);
	expect(guarded.reviewBase).toBe(baseline);
	expect(guarded.paths).toEqual(["apps/a.ts"]);
	expect(f.git("diff", "--binary", guarded.reviewBase, edited)).toContain("agent edit");
});

test("rebase inherits protected base changes and rejects agent changes", () => {
	let f = rebaseFixture();
	expect(f.validate().paths).toEqual([]);
	f.put(".github/workflows/ci.yml", "tampered");
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(() => f.validate(f.git("rev-parse", "HEAD"))).toThrow("Protected");
});

test("rebase preserves author/message and commit count", () => {
	for (
		let args of [["--author=Other <other@example.com>", "--no-edit"], ["-m", "changed message"]]
	) {
		let f = rebaseFixture();
		f.git("commit", "--amend", ...args);
		expect(() => f.validate(f.git("rev-parse", "HEAD"))).toThrow("identity");
	}
	let f = rebaseFixture();
	f.put("apps/a.ts", "extra");
	expect(() => f.validate(f.commit())).toThrow("count");
});

test("protected PR edits inherit unchanged base; conflicting protected edits reject", () => {
	let f = fixture();
	f.put(".github/workflows/ci.yml", "PR change");
	let h = f.commit();
	f.git("checkout", "--detach", f.base);
	f.put("apps/b.ts", "base");
	let b = f.commit();
	f.git("cherry-pick", h);
	let p = f.git("rev-parse", "HEAD");
	let validate = (base: string, proposal: string) =>
		validateProposal({
			directory: f.directory,
			operation: "rebase",
			expectedHead: h,
			expectedBase: base,
			proposalHead: proposal,
		});
	expect(validate(b, p).paths).toEqual([]);
	f.git("checkout", "--detach", f.base);
	f.put(".github/workflows/ci.yml", "competing");
	b = f.commit();
	f.put(".github/workflows/ci.yml", "PR change");
	p = f.commit();
	expect(() => validate(b, p)).toThrow("conflict");
});

test("explicit stack boundary replays only child commits", () => {
	let f = fixture();
	f.put("apps/parent.ts", "old");
	let boundary = f.commit("parent");
	f.put("apps/child.ts", "child");
	let h = f.commit("child");
	f.git("checkout", "--detach", f.base);
	f.put("apps/parent.ts", "new");
	let b = f.commit("new parent");
	f.git("cherry-pick", h);
	let p = f.git("rev-parse", "HEAD");
	let options = {
		directory: f.directory,
		operation: "rebase",
		expectedHead: h,
		expectedBase: b,
		proposalHead: p,
	};
	expect(validateProposal({ ...options, oldReplayBoundary: boundary }).paths).toEqual([]);
	expect(() => validateProposal(options)).toThrow("count");
});

test("exact hash renewal checks proposal bytes and bounded review", () => {
	let f = fixture();
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	let hash = (s: string) => createHash("sha256").update(s).digest("hex");
	let entry = { file: "apps/a.ts", sourceHash: hash("initial"), reason: "existing" };
	f.put(path, JSON.stringify([entry]));
	let h = f.commit();
	f.put("apps/a.ts", "updated");
	let updated = { ...entry, sourceHash: hash("updated") };
	f.put(path, JSON.stringify([updated]));
	let p = f.commit();
	let options = {
		directory: f.directory,
		operation: "fix",
		expectedHead: h,
		expectedBase: f.base,
		proposalHead: p,
		hashReviews: [{
			file: "apps/a.ts",
			sourceHash: updated.sourceHash,
			rationale: "Same flow reviewed",
		}],
	};
	expect(validateProposal(options).paths).toContain(path);
	expect(() => validateProposal({ ...options, hashReviews: [] })).toThrow("review");
	f.put(path, JSON.stringify([{ ...updated, reason: "broadened" }]));
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(() => validateProposal({ ...options, proposalHead: f.git("rev-parse", "HEAD") })).toThrow(
		"beyond",
	);
});

test("rejects merge proposals and stale hash bytes", () => {
	let f = fixture();
	f.put("apps/a.ts", "head");
	let h = f.commit();
	f.git("checkout", "--detach", f.base);
	f.put("apps/b.ts", "branch");
	let other = f.commit();
	f.git("checkout", "--detach", h);
	f.git("merge", "--no-ff", "-m", "merge", other);
	expect(() => fix(f, h, f.git("rev-parse", "HEAD"))).toThrow("linear");
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	f.git("checkout", "--detach", f.base);
	let entry = { file: "apps/a.ts", sourceHash: "a".repeat(64) };
	f.put(path, JSON.stringify([entry]));
	h = f.commit();
	f.put(path, JSON.stringify([{ ...entry, sourceHash: "b".repeat(64) }]));
	expect(() => fix(f, h, f.commit())).toThrow("bytes");
});

test("rebase hash renewal compares inherited base JSON; protected symlinks inherit", () => {
	let f = fixture();
	let path = "scripts/design-contract/exceptions/dynamic-web.json";
	let hash = (value: string) => createHash("sha256").update(value).digest("hex");
	let entry = { file: "apps/a.ts", sourceHash: hash("initial"), reason: "unchanged" };
	f.put(path, JSON.stringify([entry]));
	symlinkSync("/etc/passwd", join(f.directory, ".github/existing-link"));
	let boundary = f.commit("initial exceptions");
	f.put("apps/a.ts", "feature");
	let h = f.commit("feature");
	f.git("checkout", "--detach", boundary);
	let inherited = { ...entry, reason: "base reviewed reason" };
	f.put(path, JSON.stringify([inherited]));
	let b = f.commit("base policy update");
	f.git("cherry-pick", h);
	f.put(path, JSON.stringify([{ ...inherited, sourceHash: hash("feature") }]));
	f.git("add", ".");
	f.git("commit", "--amend", "--no-edit");
	expect(
		validateProposal({
			directory: f.directory,
			operation: "rebase",
			expectedHead: h,
			expectedBase: b,
			proposalHead: f.git("rev-parse", "HEAD"),
			hashReviews: [{
				file: "apps/a.ts",
				sourceHash: hash("feature"),
				rationale: "Existing scope",
			}],
		}).paths,
	).toEqual([path]);
});

test("rejects invalid UTF-8 Git paths that alias regular files or protected paths", () => {
	for (let protectedPath of [false, true]) {
		let f = fixture();
		let prefix = protectedPath ? ".github/workflows/x" : "apps/x";
		let invalid = Buffer.concat([Buffer.from(prefix), Buffer.from([0x80])]);
		let valid = `${prefix}\uFFFD`;
		f.put(valid, "ordinary regular blob");
		f.git("add", ".");
		let blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
			cwd: f.directory,
			input: protectedPath ? "protected workflow" : "/etc/passwd",
			encoding: "utf8",
		}).trim();
		execFileSync("git", ["update-index", "-z", "--index-info"], {
			cwd: f.directory,
			input: Buffer.concat([
				Buffer.from(`${protectedPath ? "100644" : "120000"} ${blob}\t`),
				invalid,
				Buffer.from([0]),
			]),
		});
		f.git("commit", "-m", "raw byte path proposal");
		let p = f.git("rev-parse", "HEAD");
		expect(() => fix(f, f.base, p)).toThrow("UTF-8");
	}
});
