import { expect, test } from "bun:test";
import "./isolated-git.test-fixtures";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin, initialState } from "./state.mjs";
import { openResult } from "./actions.mjs";
import { runWorker } from "./worker-run.mjs";
let key = "k".repeat(32);
function context(output: unknown) {
	let directory = mkdtempSync(join(tmpdir(), "worker-runtime-"));
	let state = begin(
		initialState({ number: 3, head: "h", baseHead: "b", action: "repair" }, 1),
		"a",
		2,
	);
	let outputPath = join(directory, "output.json");
	writeFileSync(outputPath, JSON.stringify(output));
	return {
		repository: "o/r",
		number: 3,
		attempt: "a",
		runId: "12",
		key,
		directory,
		outputPath,
		resultPath: join(directory, "result.json"),
		store: { load: async () => ({ payload: { repository: "o/r", prs: { 3: state } } }) },
	};
}
test("report binds the signed result to trusted run and neutral outcome", async () => {
	let config = context({
		items: [{
			type: "finish_attempt",
			kind: "human",
			review: "",
			attempt: "a",
			reason: "Choose parent",
		}],
	});
	expect(await runWorker("finish", config)).toEqual({ kind: "blocked", reason: "Choose parent" });
	expect(openResult(JSON.parse(readFileSync(config.resultPath, "utf8")), config, key)).toEqual({
		kind: "blocked",
		reason: "Choose parent",
	});
});

test("human and infrastructure reports accept absent or empty optional review", async () => {
	for (let kind of ["human", "infrastructure"]) {
		for (let review of [undefined, ""]) {
			let config = context({
				items: [{ type: "finish_attempt", attempt: "a", kind, review, reason: "Choose parent" }],
			});
			let expected = { kind: kind === "human" ? "blocked" : "transient", reason: "Choose parent" };
			expect(await runWorker("finish", config)).toEqual(expected);
			expect(openResult(JSON.parse(readFileSync(config.resultPath, "utf8")), config, key))
				.toEqual(expected);
		}
	}
});

test("optional fields never admit invalid types or unknown fields and reports still need a reason", async () => {
	for (
		let change of [
			{ review: null },
			{ reason: 5 },
			{ extra: "unexpected" },
			{ reason: undefined },
			{ reason: "" },
			{ reason: " " },
			{ reason: "x".repeat(4097) },
		]
	) {
		let config = context({
			items: [{
				type: "finish_attempt",
				attempt: "a",
				kind: "human",
				reason: "Choose parent",
				...change,
			}],
		});
		expect(await runWorker("finish", config)).toEqual({
			kind: "transient",
			reason: "Worker infrastructure failure; inspect Actions logs",
		});
	}
});

test("proposal optional omissions reach guarded application without inventing a review", async () => {
	for (let fields of [{ review: "exact diff" }, { reason: "" }, {}]) {
		let config = context({
			items: [{ type: "finish_attempt", attempt: "a", kind: "proposal", ...fields }],
		});
		let calls = 0;
		let result = await runWorker("finish", {
			...config,
			request: async () => {
				calls++;
				throw new Error("unavailable");
			},
			push: async () => {
				throw new Error("must not push");
			},
		});
		expect(calls).toBe(1);
		expect(result.kind).toBe("transient");
	}
});
test("multiple or wrong-attempt safe outputs become sanitized infrastructure failure", async () => {
	for (
		let items of [[{
			type: "finish_attempt",
			kind: "infrastructure",
			review: "",
			attempt: "wrong",
			reason: "secret",
		}], [{
			type: "finish_attempt",
			kind: "infrastructure",
			review: "",
			attempt: "a",
			reason: "x",
		}, { type: "finish_attempt", kind: "human", review: "", attempt: "a", reason: "y" }]]
	) {
		let config = context({ items });
		expect(await runWorker("finish", config)).toEqual({
			kind: "transient",
			reason: "Worker infrastructure failure; inspect Actions logs",
		});
	}
});
test("superseded reports cannot block a new episode", async () => {
	let config = context({
		items: [{ type: "finish_attempt", kind: "human", review: "", attempt: "a", reason: "x" }],
	});
	let loaded = await config.store.load();
	loaded.payload.prs[3].episode++;
	config.store.load = async () => loaded;
	expect(await runWorker("finish", config)).toEqual({ kind: "superseded" });
});
test("operational state failures are signed without leaking errors", async () => {
	let config = context({ items: [] });
	config.store.load = async () => {
		throw new Error("secret token");
	};
	expect((await runWorker("finish", config)).reason).not.toContain("secret");
	expect(openResult(JSON.parse(readFileSync(config.resultPath, "utf8")), config, key).kind).toBe(
		"transient",
	);
});

test("prepare copies trusted main guidance and writes no credentials or state mutations", async () => {
	let config = context(null);
	let git = (...args: string[]) =>
		execFileSync("git", args, { cwd: config.directory, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.email", "test@example.test");
	git("config", "user.name", "Test");
	writeFileSync(join(config.directory, "AGENTS.md"), "trusted guidance");
	git("add", "AGENTS.md");
	git("commit", "-qm", "base");
	let head = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", head);
	let loaded = await config.store.load();
	let state = loaded.payload.prs[3];
	state.head =
		state.baseHead =
		state.active.head =
		state.active.baseHead =
			head;
	config.store.load = async () => loaded;
	let full = {
		...config,
		dataDirectory: join(config.directory, "data"),
		request: async (_method: string, path: string) =>
			path.includes("/pulls/")
				? {
					state: "open",
					draft: false,
					head: { sha: head, ref: "feature", repo: { full_name: "o/r" } },
					base: { ref: "main", repo: { full_name: "o/r" } },
					labels: [],
				}
				: { commit: { sha: head } },
	};
	let result = await runWorker("prepare", full);
	expect(result.head).toBe(head);
	expect(result.operation).toBe("fix");
	for (let change of [{ state: "closed" }, { draft: true }]) {
		let request = full.request;
		let rejected = await runWorker("prepare", {
			...full,
			request: async (method, path) => {
				let response = await request(method, path);
				return path.includes("/pulls/") ? { ...response, ...change } : response;
			},
		});
		expect(rejected.kind).toBe("transient");
	}

	state.action = state.active.action = "conflict";
	state.active.operation = "merge";
	expect((await runWorker("prepare", full)).operation).toBe("merge");
	expect(readFileSync(join(full.dataDirectory, "trusted-AGENTS.md"), "utf8")).toBe(
		"trusted guidance",
	);
	expect(readFileSync(join(full.dataDirectory, "pr-attempt.json"), "utf8")).not.toContain(key);
});

test("finish rejects unknown kinds and maps infrastructure reports", async () => {
	for (let kind of ["infrastructure", "unknown"]) {
		let config = context({
			items: [{ type: "finish_attempt", attempt: "a", kind, review: "", reason: "failure" }],
		});
		let result = await runWorker("finish", config);
		expect(result.kind).toBe("transient");
		expect(result.reason).toBe(
			kind === "infrastructure" ? "failure" : "Worker infrastructure failure; inspect Actions logs",
		);
	}
});
test("finish proposal uses real application and sanitizes unavailable API", async () => {
	let config = context({
		items: [{ type: "finish_attempt", attempt: "a", kind: "proposal", review: "", reason: "" }],
	});
	let result = await runWorker("finish", {
		...config,
		request: async () => {
			throw new Error("credential detail");
		},
		push: async () => {
			throw new Error("must not push");
		},
	});
	expect(result).toEqual({
		kind: "transient",
		reason: "Worker infrastructure failure; inspect Actions logs",
	});
});

test("registered proposal recovery reaches application after head and action observation change", async () => {
	let config = context({
		items: [{ type: "finish_attempt", attempt: "a", kind: "proposal", review: "", reason: "" }],
	});
	let loaded = await config.store.load();
	let state = loaded.payload.prs[3];
	state.active.proposalHead = "published";
	state.head = "published";
	state.action = "waiting-ci";
	config.store.load = async () => loaded;
	let calls = 0;
	let result = await runWorker("finish", {
		...config,
		request: async () => {
			calls++;
			throw new Error("unavailable");
		},
		push: async () => {},
	});
	expect(calls).toBe(1);
	expect(result.kind).toBe("transient");
});
