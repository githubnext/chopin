import { describe, expect, it } from "bun:test";

import { ACTOR_STORAGE_KEY, actorTitle, chatDraftKey, launchUrl, resolveActor } from "./demo-actor";

const LILY = { id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" };
const FELIX = { id: "demo:felix", name: "Felix", avatar: "/demo/felix.svg" };

function memory(initial: Record<string, string> = {}) {
	let data = new Map(Object.entries(initial));
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	};
}

describe("resolveActor", () => {
	it("consumes a launch hint, stores it, and strips it from the URL", () => {
		let storage = memory();
		let result = resolveActor("?persona=demo:lily&x=1", [LILY, FELIX], storage);
		expect(result.actor).toEqual(LILY);
		expect(result.strippedSearch).toBe("?x=1");
		expect(storage.data.get(ACTOR_STORAGE_KEY)).toBe("demo:lily");
		expect(resolveActor("?persona=demo:felix", [LILY, FELIX], storage).strippedSearch).toBe("");
	});

	it("never adopts an actor from a plain URL", () => {
		let result = resolveActor("", [LILY, FELIX], memory());
		expect(result.actor).toBeUndefined();
		expect(result.strippedSearch).toBeUndefined();
	});

	it("keeps the persona across a reload from sessionStorage", () => {
		let storage = memory({ [ACTOR_STORAGE_KEY]: "demo:felix" });
		expect(resolveActor("", [LILY, FELIX], storage).actor).toEqual(FELIX);
	});

	it("drops hints and stored personas the roster does not know", () => {
		let storage = memory({ [ACTOR_STORAGE_KEY]: "demo:lily" });
		let result = resolveActor("?persona=demo:mallory", [FELIX], storage);
		expect(result.actor).toBeUndefined();
		expect(result.strippedSearch).toBe("");
		expect(storage.data.has(ACTOR_STORAGE_KEY)).toBe(false);
		storage.data.set(ACTOR_STORAGE_KEY, "demo:lily");
		expect(resolveActor("?persona=demo:lily", [], storage).actor).toBeUndefined();
		expect(storage.data.has(ACTOR_STORAGE_KEY)).toBe(false);
	});

	it("ignores repeated hints", () => {
		let result = resolveActor("?persona=demo:lily&persona=demo:felix", [LILY, FELIX], memory());
		expect(result.actor).toBeUndefined();
		expect(result.strippedSearch).toBe("");
	});
});

describe("launch helpers", () => {
	it("adds the hint only to the launch URL", () => {
		let url = new URL(launchUrl("https://x.test/documents/a/b/c?q=1#h", "demo:lily"));
		expect(url.searchParams.get("persona")).toBe("demo:lily");
		expect(url.searchParams.get("q")).toBe("1");
		expect(url.hash).toBe("#h");
	});

	it("titles an actor's tab and scopes drafts per actor", () => {
		expect(actorTitle("chopin", LILY)).toBe("Lily in chopin");
		expect(actorTitle("chopin", undefined)).toBe("chopin");
		expect(chatDraftKey("r", undefined)).toBe("chopin:chat-draft:r");
		expect(chatDraftKey("r", "demo:lily")).not.toBe(chatDraftKey("r", "demo:felix"));
		expect(chatDraftKey("r", "demo:lily")).not.toBe(chatDraftKey("r", undefined));
	});
});
