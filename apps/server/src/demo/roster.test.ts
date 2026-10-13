import { describe, expect, test } from "bun:test";
import { demoRoster } from "./roster";

describe("demo roster", () => {
	test("enabled exposes Lily and Felix with stable ids and local avatars", () => {
		let roster = demoRoster({ demoPersonas: true });
		expect(roster.list().map(actor => actor.id)).toEqual(["demo:lily", "demo:felix"]);
		expect(roster.get("demo:lily")).toEqual({
			id: "demo:lily",
			name: "Lily",
			avatar: "/demo/lily.svg",
		});
		expect(roster.get("demo:felix")?.name).toBe("Felix");
		for (let actor of roster.list()) expect(actor.avatar.startsWith("/")).toBe(true);
	});

	test("unknown or arbitrary ids are refused", () => {
		let roster = demoRoster({ demoPersonas: true });
		for (let id of ["demo:mallory", "lily", "Demo:Lily", "demo:", "", "octocat", "__proto__"]) {
			expect(roster.get(id)).toBeUndefined();
		}
	});

	test("disabled resolves nothing", () => {
		let roster = demoRoster({});
		expect(roster.list()).toEqual([]);
		expect(roster.get("demo:lily")).toBeUndefined();
	});
});
