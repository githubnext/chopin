import { describe, expect, it } from "bun:test";

import { canWithdraw } from "./withdraw";

describe("canWithdraw", () => {
	it("lets only the queuing actor withdraw", () => {
		let queue = [{ id: "m1", handle: "demo:lily" }, { id: "m2", handle: "maggie" }];
		expect(canWithdraw(queue, "m1", "demo:lily")).toBe(true);
		expect(canWithdraw(queue, "m1", "maggie")).toBe(false);
		expect(canWithdraw(queue, "m2", "demo:lily")).toBe(false);
		expect(canWithdraw(queue, "gone", "maggie")).toBe(false);
	});
});
