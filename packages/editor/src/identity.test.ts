import { describe, expect, it } from "bun:test";

import { isDemoHandle, personName, setFaceProfiles } from "./people";
import { withIdentity } from "./identity";
import { displayName } from "./display-name";

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
	it("uses the same actor name in Chat and comments as beside the cursor", () => {
		setFaceProfiles([{ id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" }]);
		try {
			expect(displayName("demo:lily")).toBe("Lily");
			expect(displayName("demo:felix")).toBe("Felix");
			expect(displayName("octocat")).toBe("Octocat");
		} finally {
			setFaceProfiles([]);
		}
	});
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
