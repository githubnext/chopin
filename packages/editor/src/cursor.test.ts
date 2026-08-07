import { describe, expect, it } from "bun:test";

import { color, cursor } from "./cursor";

let identities = [
	["kris", "#BF5257"],
	["erin", "#B25D25"],
	["carol", "#977103"],
	["frank", "#54803A"],
	["bob", "#358264"],
	["person7", "#4375C9"],
	["heidi", "#7E65BB"],
	["alice", "#A45B9F"],
] as const;

function channel(value: number): number {
	let linear = value / 255;
	return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
}

function contrastAgainstWhite(hex: string): number {
	let channels = hex.match(/[0-9a-f]{2}/gi)!.map(value => channel(Number.parseInt(value, 16)));
	let luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
	return 1.05 / (luminance + 0.05);
}

describe("account colours", () => {
	it("maps the eight hash buckets to the designed palette", () => {
		for (let [login, expected] of identities) expect(color(login)).toBe(expected);
	});

	it("keeps white identity text legible in every colour", () => {
		for (let [login] of identities) {
			expect(contrastAgainstWhite(color(login))).toBeGreaterThanOrEqual(4.48);
		}
	});

	it("derives the same identity wherever a login is used", () => {
		let firstClient = cursor("alice");
		let secondClient = cursor("alice");

		expect(firstClient).toEqual({ name: "alice", color: "#A45B9F" });
		expect(secondClient).toEqual(firstClient);
	});
});
