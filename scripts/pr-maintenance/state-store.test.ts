import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createStateStore, openState, sealState } from "./state-store.mjs";

let key = Buffer.alloc(32, 7);
let repository = "githubnext/chopin";
let payload = { schemaVersion: 1, repository, revision: 0, prs: { "12": { status: "waiting" } } };
let sha = "a".repeat(40);
let path = "/repos/githubnext/chopin/contents/state.json";
function file(value = sealState(payload, key)) {
	let content = Buffer.from(JSON.stringify(value)).toString("base64");
	return {
		type: "file",
		name: "state.json",
		path: "state.json",
		sha,
		encoding: "base64",
		size: Buffer.from(content, "base64").length,
		content,
	};
}

test("round trips authenticated state with string and Buffer keys", () => {
	expect(openState(sealState(payload, key), repository, key)).toEqual(payload);
	let stringKey = "é".repeat(16);
	expect(openState(sealState(payload, stringKey), repository, stringKey)).toEqual(payload);
});

test("rejects tampering, foreign repositories, wrong keys and malformed signatures", () => {
	let envelope = sealState(payload, key);
	for (
		let value of [
			{ ...envelope, payload: { ...payload, revision: 1 } },
			{ ...envelope, signature: "0".repeat(64) },
			{ ...envelope, signature: envelope.signature.toUpperCase() },
			{ ...envelope, signature: "bad" },
			null,
		]
	) expect(() => openState(value, repository, key)).toThrow();
	expect(() => openState(envelope, "other/repo", key)).toThrow();
	expect(() => openState(envelope, repository, Buffer.alloc(32, 8))).toThrow();
});

test("rejects invalid schema, revision, PR identities and nonobject state", () => {
	for (
		let value of [
			{ ...payload, schemaVersion: 2 },
			{ ...payload, revision: -1 },
			{ ...payload, revision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...payload, prs: [] },
			{ ...payload, prs: { "01": {} } },
			{ ...payload, prs: { "0": {} } },
			{ ...payload, prs: { "12": [] } },
			{ ...payload, prs: { "12": null } },
			{ ...payload, prs: { "12": { value: Infinity } } },
			{ ...payload, extra: true },
		]
	) expect(() => sealState(value, key)).toThrow();
});

test("rejects oversized state and short or invalid keys without exposing them", () => {
	expect(() => sealState({ ...payload, prs: { "12": { text: "x".repeat(1024 * 1024) } } }, key))
		.toThrow();
	for (let badKey of ["private-short-key", Buffer.alloc(31), 123]) {
		try {
			sealState(payload, badKey);
			throw new Error("accepted key");
		} catch (error) {
			expect(String(error)).not.toContain("private-short-key");
			expect(String(error)).not.toContain("accepted key");
		}
	}
});

test("loads only the fixed branch file and returns its authenticated payload and SHA", async () => {
	let store = createStateStore(repository, key, async (method, url, body) => {
		expect([method, url, body]).toEqual([
			"GET",
			`${path}?ref=automation%2Fpr-maintenance-state`,
			undefined,
		]);
		return file();
	});
	expect(await store.load()).toEqual({ sha, payload });
});

test("missing store and malformed GitHub files fail visibly", async () => {
	let missing = createStateStore(repository, key, async () => {
		throw Object.assign(new Error("secret remote data"), { status: 404 });
	});
	await expect(missing.load()).rejects.toThrow("404");
	for (
		let value of [
			null,
			[],
			{ ...file(), type: "dir" },
			{ ...file(), path: "other.json" },
			{ ...file(), encoding: "none" },
			{ ...file(), sha: "" },
			{ ...file(), content: "?bad" },
			{ ...file(), size: 0 },
			{ ...file(), content: Buffer.from("bad json").toString("base64") },
		]
	) {
		await expect(createStateStore(repository, key, async () => value).load()).rejects.toThrow();
	}
});

test("save increments revision and sends signed content with previous SHA", async () => {
	let next = { ...payload, revision: 1 };
	let newSha = "b".repeat(40);
	let store = createStateStore(repository, key, async (method, url, body) => {
		expect([method, url]).toEqual(["PUT", path]);
		expect(body.branch).toBe("automation/pr-maintenance-state");
		expect(body.sha).toBe(sha);
		expect(openState(JSON.parse(Buffer.from(body.content, "base64").toString()), repository, key))
			.toEqual(next);
		return { content: { type: "file", path: "state.json", name: "state.json", sha: newSha } };
	});
	expect(await store.save({ sha, payload }, next)).toEqual({ sha: newSha, payload: next });
	for (let invalid of [payload, { ...next, revision: 2 }, { ...next, repository: "other/repo" }]) {
		await expect(store.save({ sha, payload }, invalid)).rejects.toThrow();
	}
});

test("conflicting writes do not retry or expose remote errors", async () => {
	let calls = 0;
	let store = createStateStore(repository, key, async () => {
		calls++;
		throw Object.assign(new Error("private-short-key raw-state"), { status: 409 });
	});
	await expect(store.save({ sha, payload }, { ...payload, revision: 1 })).rejects.toThrow("409");
	expect(calls).toBe(1);
});

test("signature binds exact serialization and fixed authentication domain", () => {
	let envelope = sealState(payload, key);
	let bareSignature = createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
	expect(envelope.signature).not.toBe(bareSignature);
	let reordered = { repository, schemaVersion: 1, revision: 0, prs: payload.prs };
	expect(() => openState({ ...envelope, payload: reordered }, repository, key)).toThrow();
});

test("two writers loaded at one SHA cannot overwrite each other's revision", async () => {
	let current = file();
	let writes = 0;
	let request = async (method, _url, body) => {
		if (method === "GET") return { ...current };
		writes++;
		if (body.sha !== current.sha) throw Object.assign(new Error("conflict"), { status: 409 });
		current = {
			...current,
			sha: "b".repeat(40),
			content: body.content,
			size: Buffer.from(body.content, "base64").length,
		};
		return { content: current };
	};
	let first = createStateStore(repository, key, request);
	let second = createStateStore(repository, key, request);
	let [a, b] = await Promise.all([first.load(), second.load()]);
	await first.save(a, { ...payload, revision: 1, prs: { "12": { status: "active" } } });
	await expect(second.save(b, { ...payload, revision: 1, prs: { "12": { status: "ready" } } }))
		.rejects.toThrow("409");
	expect(writes).toBe(2);
	expect((await second.load()).payload.prs["12"].status).toBe("active");
});

test("rejects array getters and serialization hooks without invoking them or exposing errors", () => {
	let invoked = 0;
	let getter = [1];
	Object.defineProperty(getter, "0", {
		enumerable: true,
		get() {
			invoked++;
			throw new Error("RAW_STATE_SECRET");
		},
	});
	let hook = [1];
	Object.defineProperty(hook, "toJSON", {
		value() {
			invoked++;
			return ["altered"];
		},
	});
	for (let list of [getter, hook]) {
		let message = "";
		try {
			sealState({ ...payload, prs: { "12": { list } } }, key);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("JSON values only");
		expect(message).not.toContain("RAW_STATE_SECRET");
	}
	expect(invoked).toBe(0);
});

test("rejects array extra properties, symbol properties, sparse and noncanonical indices", () => {
	let extra = Object.assign([1], { other: "ignored" });
	let symbol = [1];
	Object.defineProperty(symbol, Symbol("extra"), { value: 2 });
	let sparse = [];
	sparse.length = 2;
	let noncanonical = Object.assign([1], { "01": 2 });
	for (let list of [extra, symbol, sparse, noncanonical]) {
		expect(() => sealState({ ...payload, prs: { "12": { list } } }, key)).toThrow(
			"JSON values only",
		);
	}
	let regular = { ...payload, prs: { "12": { list: [1, null, { nested: [false, "value"] }] } } };
	expect(openState(sealState(regular, key), repository, key)).toEqual(regular);
});
