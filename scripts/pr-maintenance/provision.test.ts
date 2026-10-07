import { expect, test } from "bun:test";
import { provisionState } from "./provision.mjs";
import { openState, sealState } from "./state-store.mjs";

let repository = "githubnext/chopin";
let key = "a".repeat(32);
let sha = "1".repeat(40);

test("initialization signs an empty state before creating its fixed branch and file", async () => {
	let writes: any[] = [];
	let result = await provisionState(repository, key, async (method, path, body) => {
		if (path.endsWith("/git/ref/heads/automation/pr-maintenance-state")) {
			throw Object.assign(new Error("absent"), { status: 404 });
		}
		if (path.endsWith("/git/ref/heads/main")) return { object: { sha } };
		writes.push({ method, path, body });
		return {};
	});
	expect(result).toEqual({ created: true });
	expect(writes.map(write => write.method)).toEqual(["POST", "PUT"]);
	expect(writes[0].body).toEqual({ ref: "refs/heads/automation/pr-maintenance-state", sha });
	expect(writes[1].body.branch).toBe("automation/pr-maintenance-state");
	expect(
		openState(
			JSON.parse(Buffer.from(writes[1].body.content, "base64").toString()),
			repository,
			key,
		),
	)
		.toEqual({ schemaVersion: 1, repository, revision: 0, prs: {} });
});

test("existing signed state is read only; invalid or missing existing state cannot be reset", async () => {
	let envelope = sealState({ schemaVersion: 1, repository, revision: 12, prs: {} }, key);
	let content = Buffer.from(JSON.stringify(envelope)).toString("base64");
	let writes = 0;
	let bad = false;
	let request = async (method, path) => {
		if (method !== "GET") writes++;
		if (path.includes("/git/ref/heads/")) return { object: { sha } };
		if (bad) throw Object.assign(new Error("missing state"), { status: 404 });
		return {
			type: "file",
			name: "state.json",
			path: "state.json",
			sha,
			encoding: "base64",
			size: Buffer.from(content, "base64").length,
			content,
		};
	};
	expect(await provisionState(repository, key, request)).toEqual({ created: false });
	bad = true;
	await expect(provisionState(repository, key, request)).rejects.toThrow(
		"Maintenance state GET failed",
	);
	expect(writes).toBe(0);
});

test("lookup failures and invalid key fail before any initialization writes", async () => {
	let writes = 0;
	let request = async (method) => {
		if (method !== "GET") writes++;
		throw Object.assign(new Error("credential details"), { status: 403 });
	};
	await expect(provisionState(repository, key, request)).rejects.toThrow(
		"State branch lookup failed",
	);
	await expect(provisionState(repository, "short", request)).rejects.toThrow();
	expect(writes).toBe(0);
});
