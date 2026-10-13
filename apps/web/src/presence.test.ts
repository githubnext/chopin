import { describe, expect, it } from "bun:test";

import { peopleHere } from "./presence";

describe("people here", () => {
	it("represents one verified GitHub account once across its connections", () => {
		expect(peopleHere([
			{ handle: "e2e", client: "tab-1" },
			{ handle: "e2e", client: "tab-2" },
			{ handle: "E2E", client: "tab-3" },
		])).toEqual(["e2e"]);
	});

	it("keeps different verified GitHub accounts separate", () => {
		expect(peopleHere([
			{ handle: "ana", client: "ana-tab" },
			{ handle: "bo", client: "bo-tab" },
		])).toEqual(["ana", "bo"]);
	});

	it("keeps a person while any of their connections remains", () => {
		expect(peopleHere([
			{ handle: "e2e", client: "tab-2" },
			{ handle: "e2e", client: "tab-3" },
		])).toEqual(["e2e"]);
	});

	it("shows a presenter and personas together, merging only repeat tabs of one actor", () => {
		let lily = { name: "Lily", avatar: "/demo/lily.svg" };
		expect(peopleHere([
			{ handle: "maggie", client: "a" },
			{ handle: "demo:lily", client: "b", actor: lily },
			{ handle: "demo:lily", client: "c", actor: lily },
			{ handle: "demo:felix", client: "d", actor: { name: "Felix", avatar: "/demo/felix.svg" } },
		])).toEqual(["maggie", "demo:lily", "demo:felix"]);
	});
});
