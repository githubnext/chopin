import { describe, expect, it } from "bun:test";

import { isDemoHandle, personName, setFaceProfiles } from "./face";
import { withIdentity } from "./identity";

describe("withIdentity", () => {
	it("rebuilds the whole state and keeps the caret", () => {
		let state = { name: "maggie", color: "#111", focusing: true, anchorPos: { a: 1 } };
		let next = withIdentity(state, { name: "Lily", color: "#222" });
		expect(next).toEqual({ ...state, name: "Lily", color: "#222" });
		expect(next).not.toBe(state);
	});

	it("is a no-op for the same identity and never revives a cleared state", () => {
		let state = { name: "a", color: "#1" };
		expect(withIdentity(state, { name: "a", color: "#1" })).toBe(state);
		expect(withIdentity(null, { name: "a", color: "#1" })).toBeNull();
	});
});

describe("face identity", () => {
	it("names demo actors from the roster and never treats them as GitHub logins", () => {
		setFaceProfiles([{ id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" }]);
		expect(personName("demo:lily")).toBe("Lily");
		expect(personName("demo:other")).toBe("other");
		expect(personName("maggie")).toBe("maggie");
		expect(isDemoHandle("demo:lily")).toBe(true);
		expect(isDemoHandle("maggie")).toBe(false);
		setFaceProfiles([]);
	});
});
