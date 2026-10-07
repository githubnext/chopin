import { expect, test } from "bun:test";
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

function rebaseFixture() {
	let f = fixture();
	f.put("apps/a.ts", "feature");
	let head = f.commit("feature message");
	f.git("checkout", "--detach", f.base);
	f.put(".github/workflows/ci.yml", "base update");
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
