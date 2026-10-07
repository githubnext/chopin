import { expect, test } from "bun:test";
import { failureFingerprint, getFailureFingerprint } from "./failures.mjs";
let repository = "a/b";
let run = {
	id: 12,
	head_sha: "a".repeat(40),
	head_branch: "feature",
	head_repository: { full_name: repository },
	path: ".github/workflows/ci.yml",
	event: "pull_request",
	status: "completed",
	conclusion: "failure",
};
test("same diagnostic ignores timestamps, ANSI, head SHA and elapsed time", () => {
	let first = `checks\tRun tests\t2026-10-07T12:10:11.000Z checkout ${
		"a".repeat(40)
	}\nchecks\tRun tests\t2026-10-07T12:10:12.000Z error: expected 3, received 4\nchecks\tRun tests\t2026-10-07T12:10:12.000Z in widget.test.ts (10.00ms)`;
	let second = first.replaceAll("2026-10-07T12:10:12.000Z", "2026-10-08T13:15:10.123Z").replaceAll(
		"a".repeat(40),
		"b".repeat(40),
	).replace("10.00ms", "900.00ms").replace(
		"error:",
		`${String.fromCharCode(27)}[31merror:${String.fromCharCode(27)}[0m`,
	);
	expect(failureFingerprint(first)).toBe(failureFingerprint(second));
	expect(failureFingerprint(first.replace("received 4", "received 5"))).not.toBe(
		failureFingerprint(first),
	);
	expect(failureFingerprint("completed with no diagnostic")).toBeNull();
	expect(failureFingerprint("##[error]Process completed with exit code 1")).toBeNull();
	expect(failureFingerprint("::error file=app.ts::Expected true")).not.toBe(
		failureFingerprint("::error file=app.ts::Expected false"),
	);
});
test("only trusted failed CI identity reaches bounded fixed-argument log reader", () => {
	let args;
	let read = (_binary, argv, options) => {
		args = argv;
		expect(options.maxBuffer).toBeLessThanOrEqual(2 * 1024 * 1024);
		return "error: broken test";
	};
	expect(getFailureFingerprint(repository, run, read)).toMatch(/^[0-9a-f]{64}$/);
	expect(args).toEqual(["run", "view", "12", "--repo", repository, "--log-failed"]);
	for (
		let change of [{ id: "12;echo" }, { status: "queued" }, { conclusion: "success" }, {
			path: ".github/workflows/foreign.yml",
		}, { head_repository: { full_name: "foreign/repo" } }]
	) {
		expect(getFailureFingerprint(repository, { ...run, ...change }, () => {
			throw new Error("must not run");
		})).toBeNull();
	}
	expect(getFailureFingerprint(repository, run, () => {
		throw new Error("secret-value");
	})).toBeNull();
});
