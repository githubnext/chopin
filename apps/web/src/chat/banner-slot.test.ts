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
let reconnecting: ConnectionView = { phase: "reconnecting", layer: "socket", text: "connecting" };
let catchingUp: ConnectionView = { phase: "reconnecting", layer: "sync", text: "Catching up" };
let drawn = (slot: BannerSlot) => slot.lead === "failure";
let planner = (
	plannerKind: "none" | "starting" | "cant-start" | "held" | "disconnected",
): ConnectionView =>
	plannerKind === "starting"
		? { phase: "reconnecting", layer: "planner", text: "connecting", plannerKind }
		: { phase: "dropped", layer: "planner", text: "away", plannerKind };

test("with nothing wrong with the connection a refused send, else a failed reply, is the banner", () => {
	expect(bannerSlot(undefined, false, false)).toEqual({ quietsNotices: false });
	expect(bannerSlot(online, true, true)).toEqual({ lead: "send", quietsNotices: true });
	expect(bannerSlot(online, false, true)).toEqual({ lead: "failure", quietsNotices: true });
});

test("while the offline bar shows, a refused send and a failed reply wait behind it, and the notices give way", () => {
	expect(bannerSlot(lost, true, true)).toEqual({ quietsNotices: true });
	expect(bannerSlot(reconnecting, false, true)).toEqual({ quietsNotices: true });
	expect(bannerSlot(lost, false, false)).toEqual({ quietsNotices: true });
});

test("catching up draws no bar, so it holds nothing back", () => {
	expect(bannerSlot(catchingUp, true, false)).toEqual({ lead: "send", quietsNotices: true });
	expect(bannerSlot(catchingUp, false, false)).toEqual({ quietsNotices: false });
});

test("the Planner's machine is never in the slot: whatever its state, a refused send or a failed reply shows as it would", () => {
	for (let kind of ["none", "starting", "cant-start", "held", "disconnected"] as const) {
		expect(bannerSlot(planner(kind), true, true)).toEqual({ lead: "send", quietsNotices: true });
		expect(bannerSlot(planner(kind), false, true)).toEqual({
			lead: "failure",
			quietsNotices: true,
		});
		expect(bannerSlot(planner(kind), false, false)).toEqual({ quietsNotices: false });
	}
});

test("a failed reply's line leaves the transcript only when its banner is drawn", () => {
	expect(drawn(bannerSlot(online, false, true))).toBe(true);
	expect(drawn(bannerSlot(lost, false, true))).toBe(false);
	expect(drawn(bannerSlot(planner("held"), false, true))).toBe(true);
	expect(drawn(bannerSlot(online, true, true))).toBe(false);
});

test("where the composer is not drawn there is no slot, and a failed reply's line stays in the transcript", () => {
	expect(bannerSlot(lost, true, true, false)).toEqual({ quietsNotices: false });
	expect(drawn(bannerSlot(online, false, true, false))).toBe(false);
});
