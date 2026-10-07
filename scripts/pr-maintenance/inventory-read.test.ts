import { expect, test } from "bun:test";
import { createInventoryRead } from "./inventory-read.mjs";
import { inventory } from "./inventory.mjs";
function unavailable(status) {
	let error = new Error("sensitive cause");
	error.stderr = Buffer.from(`gh: HTTP ${status}\n`);
	return error;
}
let pr = number => ({
	number,
	state: "open",
	labels: [],
	head: { sha: `head${number}`, ref: `feature${number}`, repo: { full_name: "a/b" } },
	base: { ref: "main" },
	mergeable: true,
});

test("504 retry permits inventory to inspect every PR", () => {
	let attempted = false;
	let pauses = [];
	let seen = [];

	let gh = createInventoryRead("a/b", {
		pause: ms => pauses.push(ms),
		read: (_binary, args) => {
			let path = args[1];
			seen.push(path);
			if (path === "repos/a/b/pulls/327" && !attempted) {
				attempted = true;
				throw unavailable(504);
			}
			if (path.includes("pulls?")) return JSON.stringify([[pr(327), pr(328)]]);
			if (path.includes("/pulls/")) return JSON.stringify(pr(Number(path.split("/").at(-1))));
			if (path.includes("/commits/")) return JSON.stringify({ sha: "base" });
			if (path.includes("/compare/")) return JSON.stringify({ behind_by: 0 });
			return JSON.stringify({ workflow_runs: [] });
		},
	});
	expect(inventory("a/b", gh).map(row => row.number)).toEqual([327, 328]);
	expect(pauses).toEqual([1000]);
	expect(seen).toContain("repos/a/b/pulls/328");
});
test("only server status stderr retries, exhaustion bounded and sanitized", () => {
	for (let status of [502, 503, 504, 403, 404]) {
		let calls = 0;
		let pauses = [];
		let gh = createInventoryRead("a/b", {
			pause: ms => pauses.push(ms),
			read: () => {
				calls++;
				throw unavailable(status);
			},
		});
		expect(() => gh(["api", "repos/a/b/pulls/1"])).toThrow("Inventory read unavailable");
		expect(calls).toBe(status >= 500 ? 3 : 1);
		expect(pauses).toEqual(status >= 500 ? [1000, 3000] : []);
	}
	let calls = 0;
	let gh = createInventoryRead("a/b", {
		read: () => {
			calls++;
			return "not JSON HTTP 504";
		},
		pause: () => {
			throw new Error("must not pause");
		},
	});
	expect(() => gh(["api", "repos/a/b/pulls/1"])).toThrow("Invalid inventory JSON");
	expect(calls).toBe(1);
	for (
		let args of [["api", "repos/foreign/repo/pulls/1"], [
			"api",
			"repos/a/b/pulls/1",
			"--method",
			"POST",
		], ["api", "repos/a/b/pulls/1", "--field", "title=x"]]
	) expect(() => gh(args)).toThrow("Invalid read-only inventory request");
	expect(calls).toBe(1);
});

test("classic gh status is retried but stdout and command text are not evidence", () => {
	for (let source of ["classic", "stdout", "message"]) {
		let calls = 0;
		let pauses = [];
		let gh = createInventoryRead("a/b", {
			pause: ms => pauses.push(ms),
			read: () => {
				calls++;
				if (source === "classic" && calls === 2) return "[]";
				let error = new Error(source === "message" ? "gh: HTTP 504" : "private details");
				if (source === "classic") error.stderr = "gh: gateway timeout (HTTP504)\n";
				if (source === "stdout") error.stdout = "gh: HTTP 504\n";
				throw error;
			},
		});
		if (source === "classic") expect(gh(["api", "repos/a/b/pulls/1"])).toEqual([]);
		else expect(() => gh(["api", "repos/a/b/pulls/1"])).toThrow("Inventory read unavailable");
		expect(calls).toBe(source === "classic" ? 2 : 1);
	}
});

test("valid punctuation in base refs stays a literal argument through full inventory", () => {
	let refs = ["release(v2)", "release'!", "release/v2"];
	let observed = [];
	let candidate = number => ({ ...pr(number), base: { ref: refs[number - 1] } });
	let gh = createInventoryRead("a/b", {
		read: (binary, args, options) => {
			expect(binary).toBe("gh");
			expect(options.shell).toBeUndefined();
			observed.push(args[1]);
			if (args[1].includes("pulls?")) {
				return JSON.stringify([[candidate(1), candidate(2), candidate(3)]]);
			}
			if (args[1].includes("/pulls/")) {
				return JSON.stringify(candidate(Number(args[1].split("/").at(-1))));
			}
			if (args[1].includes("/commits/")) {
				return JSON.stringify({ sha: "base" });
			}
			if (args[1].includes("/compare/")) return JSON.stringify({ behind_by: 0 });
			return JSON.stringify({ workflow_runs: [] });
		},
	});
	expect(inventory("a/b", gh).map(row => row.base)).toEqual(refs);
	for (let ref of refs) expect(observed).toContain(`repos/a/b/commits/${encodeURIComponent(ref)}`);
	let count = observed.length;
	for (
		let path of [
			"commits/..",
			"commits/..%2Fsecret",
			"commits/%2e%2e",
			"commits/release?field=x",
			"commits/release%0AInjected",
			"commits/%GG",
		]
	) expect(() => gh(["api", `repos/a/b/${path}`])).toThrow("Invalid read-only inventory request");
	expect(observed).toHaveLength(count);
});
