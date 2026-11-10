import { expect, test } from "bun:test";

import { bannerSlot } from "./banner-slot";
import type { BannerSlot } from "./banner-slot";
import type { ConnectionView } from "./connection-phase";

let online: ConnectionView = { phase: "online" };
let lost: ConnectionView = {
	phase: "dropped",
	layer: "socket",
	text: "offline",
	action: "reconnect",
};
let drawn = (slot: BannerSlot) => slot.lead === "failure";
let planner = (
	plannerKind: "none" | "starting" | "cant-start" | "held" | "disconnected",
): ConnectionView =>
	plannerKind === "starting"
		? { phase: "reconnecting", layer: "planner", text: "connecting", plannerKind }
		: { phase: "dropped", layer: "planner", text: "away", plannerKind };

test("with nothing wrong with the connection a refused send, else a failed reply, is the banner", () => {
	expect(bannerSlot(undefined, false, false)).toEqual({ connection: false, quietsNotices: false });
	expect(bannerSlot(online, true, true)).toEqual({
		lead: "send",
		connection: false,
		quietsNotices: true,
	});
	expect(bannerSlot(online, false, true)).toEqual({
		lead: "failure",
		connection: false,
		quietsNotices: true,
	});
});

test("a lost socket is the whole slot: a refused send and a failed reply wait behind it", () => {
	expect(bannerSlot(lost, true, true)).toEqual({ connection: true, quietsNotices: true });
});

test("a Planner that is absent or starting shows beside a refused send and a failed reply, and leaves the notices", () => {
	for (let kind of ["none", "starting", "cant-start"] as const) {
		expect(bannerSlot(planner(kind), true, true)).toEqual({
			lead: "send",
			connection: true,
			quietsNotices: true,
		});
		expect(bannerSlot(planner(kind), false, true)).toEqual({
			lead: "failure",
			connection: true,
			quietsNotices: true,
		});
		expect(bannerSlot(planner(kind), false, false)).toEqual({
			connection: true,
			quietsNotices: false,
		});
	}
});

test("a machine that dropped tells why a reply failed itself, but a refused send still shows", () => {
	for (let kind of ["held", "disconnected"] as const) {
		expect(bannerSlot(planner(kind), false, true)).toEqual({
			connection: true,
			quietsNotices: false,
		});
		expect(bannerSlot(planner(kind), true, true)).toEqual({
			lead: "send",
			connection: true,
			quietsNotices: true,
		});
	}
});

test("a failed reply's line leaves the transcript only when its banner is drawn", () => {
	expect(drawn(bannerSlot(online, false, true))).toBe(true);
	expect(drawn(bannerSlot(lost, false, true))).toBe(false);
	expect(drawn(bannerSlot(planner("held"), false, true))).toBe(false);
	expect(drawn(bannerSlot(online, true, true))).toBe(false);
	expect(drawn(bannerSlot(planner("none"), false, true))).toBe(true);
});

test("where the composer is not drawn there is no slot, and a failed reply's line stays in the transcript", () => {
	expect(bannerSlot(planner("none"), true, true, false)).toEqual({
		connection: false,
		quietsNotices: false,
	});
	expect(drawn(bannerSlot(online, false, true, false))).toBe(false);
});

test("a failed reply already shown stays, with its Retry, beside a machine that drops after it: another cause, its own banner", () => {
	for (let kind of ["held", "disconnected"] as const) {
		expect(bannerSlot(planner(kind), false, true, true, true)).toEqual({
			lead: "failure",
			connection: true,
			quietsNotices: true,
		});
		expect(drawn(bannerSlot(planner(kind), false, true, true, true))).toBe(true);
	}
	// The room's own connection is still the whole slot, whatever was shown before it.
	expect(bannerSlot(lost, false, true, true, true)).toEqual({
		connection: true,
		quietsNotices: true,
	});
});
