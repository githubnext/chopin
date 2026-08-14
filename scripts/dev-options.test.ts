import { describe, expect, it } from "bun:test";

import { discoverExeDev, exeDev, parseDevTarget } from "./dev-options";

describe("development options", () => {
	it("selects local and exe.dev targets explicitly", () => {
		expect(parseDevTarget([])).toBe("local");
		expect(parseDevTarget(["--exe"])).toBe("exe");
		expect(() => parseDevTarget(["exe"])).toThrow("usage");
		expect(() => parseDevTarget(["--exe", "--other"])).toThrow("usage");
	});

	it("builds an exe.dev origin only from a valid VM name", () => {
		expect(exeDev("sample-vm")).toEqual({
			name: "sample-vm",
			host: "sample-vm.exe.xyz",
			origin: "https://sample-vm.exe.xyz",
		});
		for (let name of ["", "Sample", "sample.exe.xyz", "-sample", "sample-"]) {
			expect(() => exeDev(name)).toThrow("invalid VM name");
		}
	});

	it("discovers the current VM through Reflection", async () => {
		let requested: string | undefined;
		let found = await discoverExeDev(async url => {
			requested = url;
			return Response.json({ name: "sample-vm", emoji: "ignored" });
		});

		expect(requested).toBe("https://reflection.int.exe.xyz/");
		expect(found.origin).toBe("https://sample-vm.exe.xyz");
	});

	it("rejects an unusable Reflection response", async () => {
		expect(discoverExeDev(async () => Response.json({ name: "not/a/name" }))).rejects
			.toThrow("invalid VM name");
		expect(discoverExeDev(async () => new Response(null, { status: 503 }))).rejects
			.toThrow("HTTP 503");
	});
});
