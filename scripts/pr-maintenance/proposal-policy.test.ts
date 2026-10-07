import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isRepairPath, validateHashRenewal } from "./proposal-policy.mjs";

let bytes = Buffer.from("export let value = 1;\n");
let hash = createHash("sha256").update(bytes).digest("hex");
let oldHash = "a".repeat(64);
function fixture() {
	return [{
		file: "apps/web/src/a.tsx",
		reason: "Scoped forwarding",
		cases: [["dynamic", 1]],
		sourceHash: oldHash,
		producers: [{ file: "packages/editor/src/b.ts", sourceHash: oldHash }],
	}];
}
function reviews() {
	return ["apps/web/src/a.tsx", "packages/editor/src/b.ts"].map((file) => ({
		file,
		sourceHash: hash,
		rationale: "Reviewed the unchanged forwarding scope.",
	}));
}

test("allows only ordinary canonical repair paths", () => {
	for (
		let path of [
			"README.md",
			"apps/web/src/a.tsx",
			"packages/a/src/a.ts",
			"e2e/a.e2e.ts",
			"docs/guide.md",
			"patches/a.patch",
			"scripts/e2e.ts",
		]
	) expect(isRepairPath(path)).toBe(true);
	for (
		let path of [
			"",
			"/apps/a.ts",
			"apps//a.ts",
			"apps/../a.ts",
			"apps/./a.ts",
			"apps/a/",
			"apps\\a.ts",
			"apps/a\0.ts",
			"apps/.agents/a.md",
			"apps/.codex/a.md",
			"apps/.github/a.ts",
			"apps/x/AGENTS.md",
			"docs/CLAUDE.md",
			"packages/x/a.instructions.md",
			"docs/a.prompt.md",
			"apps/x/package.json",
			"apps/x/bun.lock",
			"packages/x/bun.lockb",
			"docs/package-lock.json",
			"apps/yarn.lock",
			"apps/pnpm-lock.yaml",
			"apps/Cargo.toml",
			"apps/Cargo.lock",
			"apps/go.mod",
			"apps/go.sum",
			"apps/pyproject.toml",
			"apps/requirements-dev.txt",
			"scripts/check-design.ts",
			"scripts/check-design-record.ts",
			"scripts/design-contract/exceptions/dynamic-web.json",
			"scripts/pr-maintenance/state.mjs",
			".github/workflows/a.yml",
		]
	) expect(isRepairPath(path)).toBe(false);
});

test("renews existing group and producer hashes from real source bytes", () => {
	let before = fixture();
	let after = fixture();
	after[0].sourceHash = hash;
	after[0].producers[0].sourceHash = hash;
	expect(validateHashRenewal(before, after, () => bytes, reviews())).toEqual(
		reviews().map(({ file, sourceHash }) => ({ file, sourceHash })),
	);
});

test("preserves all exception structure and provenance", () => {
	let changes = [
		(a: any) => a.push(a[0]),
		(a: any) => a.pop(),
		(a: any) => {
			a[0].reason = "Broader";
		},
		(a: any) => {
			a[0].cases[0][1] = 2;
		},
		(a: any) => {
			a[0].file = "apps/web/src/other.ts";
		},
		(a: any) => {
			a[0].producers[0].file = "packages/editor/src/other.ts";
		},
		(a: any) => {
			a[0].extra = true;
		},
		(a: any) => {
			delete a[0].reason;
		},
	];
	for (let change of changes) {
		let after = fixture();
		change(after);
		expect(() => validateHashRenewal(fixture(), after, () => bytes, reviews())).toThrow();
	}
	let before = fixture();
	delete (before[0] as any).sourceHash;
	expect(() => validateHashRenewal(before, fixture(), () => bytes, reviews())).toThrow();
});

test("requires correct hashes even when unchanged and matching bounded reviews", () => {
	let after = fixture();
	after[0].sourceHash = hash;
	after[0].producers[0].sourceHash = hash;
	for (
		let review of [
			[],
			[{ ...reviews()[0], sourceHash: oldHash }],
			reviews().map((r) => ({ ...r, rationale: " " })),
			reviews().map((r) => ({ ...r, rationale: "x".repeat(4097) })),
		]
	) expect(() => validateHashRenewal(fixture(), after, () => bytes, review)).toThrow();
	expect(() => validateHashRenewal(fixture(), fixture(), () => bytes, reviews())).toThrow();
	expect(() => validateHashRenewal(fixture(), after, () => Buffer.from("different"), reviews()))
		.toThrow();
});

test("rejects untrusted records, non-source paths, and non-byte blobs", () => {
	for (
		let file of [
			"scripts/a.ts",
			"apps/../a.ts",
			"apps/package.json",
			"packages/.agents/a.ts",
		]
	) {
		let before = fixture();
		before[0].file = file;
		expect(() => validateHashRenewal(before, structuredClone(before), () => bytes, reviews()))
			.toThrow();
	}
	let before = fixture();
	let after = fixture();
	after[0].sourceHash = hash;
	after[0].producers[0].sourceHash = hash;
	expect(() => validateHashRenewal(before, after, () => ({ bytes }), reviews())).toThrow();
	Object.setPrototypeOf(before[0], { inherited: true });
	expect(() => validateHashRenewal(before, after, () => bytes, reviews())).toThrow();
});

test("compares array membership and order but ignores object key order", () => {
	let before = fixture();
	let after = fixture();
	after[0].sourceHash = hash;
	after[0].producers[0].sourceHash = hash;
	let reordered = after.map((group) => Object.fromEntries(Object.entries(group).toReversed()));
	expect(validateHashRenewal(before, reordered, () => bytes, reviews())).toHaveLength(2);
	let extra = structuredClone(after);
	(extra[0].cases as any).extra = "invisible change";
	expect(() => validateHashRenewal(after, extra, () => bytes, reviews())).toThrow();
	let sparse = structuredClone(after);
	delete sparse[0].cases[0];
	expect(() => validateHashRenewal(sparse, structuredClone(sparse), () => bytes, reviews()))
		.toThrow();
	let ordered = [...fixture(), { ...fixture()[0], reason: "Different scope" }];
	expect(() => validateHashRenewal(ordered, ordered.toReversed(), () => bytes, reviews()))
		.toThrow();
});
