import { describe, expect, it } from "bun:test";

import { RESTART_QUIET_MS } from "@chopin/protocol/restart";

import {
	lossOf,
	quietLeft,
	readsConnected,
	refusalOf,
	RESTART_JITTER_MS,
	restartDelay,
	restartRetryDelay,
	runningBuild,
} from "./wire-loss";

describe("lossOf", () => {
	it("reads 1012 as a restart, which reconnects quietly", () => {
		expect(lossOf(1012)).toBe("restart");
	});

	it("reads 4404 as a deleted document, which nothing can reconnect to", () => {
		expect(lossOf(4404)).toBe("deleted");
	});

	it("reads any close after session:restarting as a restart, but a deleted document still as deleted", () => {
		for (let code of [1000, 1001, 1006, 1011]) expect(lossOf(code, true)).toBe("restart");
		expect(lossOf(4404, true)).toBe("deleted");
	});

	it("reads every other close as an ordinary loss, 1001 and 1006 included", () => {
		for (let code of [1000, 1001, 1006, 1011, 4401]) expect(lossOf(code)).toBe("lost");
	});
});

describe("restartDelay", () => {
	it("is spread over 0 to 1000 ms and never reaches the end", () => {
		expect(restartDelay(0)).toBe(0);
		expect(restartDelay(0.5)).toBe(500);
		expect(restartDelay(0.999999)).toBeLessThan(RESTART_JITTER_MS);
		expect(RESTART_JITTER_MS).toBe(1000);
	});
});

describe("restartRetryDelay", () => {
	it("is about a second, spread over 250 to 1000 ms", () => {
		expect(restartRetryDelay(0)).toBe(250);
		expect(restartRetryDelay(0.5)).toBe(625);
		expect(restartRetryDelay(0.999999)).toBeLessThan(1000);
	});
});

describe("quietLeft", () => {
	it("counts a restart's quiet period down from the moment the connection was lost", () => {
		expect(RESTART_QUIET_MS).toBe(5000);
		expect(quietLeft(true, 1_000, 1_000)).toBe(RESTART_QUIET_MS);
		expect(quietLeft(true, 1_000, 3_500)).toBe(2_500);
		expect(quietLeft(true, 1_000, 1_000 + RESTART_QUIET_MS - 1)).toBe(1);
	});

	it("is over once the period has passed, when the ordinary rules and the outage take over", () => {
		expect(quietLeft(true, 1_000, 1_000 + RESTART_QUIET_MS)).toBe(0);
		expect(quietLeft(true, 1_000, 1_000 + RESTART_QUIET_MS * 3)).toBe(0);
	});

	it("is never there for a loss the server did not announce, or a connection that is not lost", () => {
		expect(quietLeft(false, 1_000, 1_000)).toBe(0);
		expect(quietLeft(true, undefined, 1_000)).toBe(0);
	});
});

describe("readsConnected", () => {
	it("holds through a restart the page is waiting out in silence, so what it draws does not change", () => {
		expect(readsConnected("reconnecting", true, true)).toBe(true);
		expect(readsConnected("connecting", true, true)).toBe(true);
	});

	it("lets go once the restart outlasts its silence, and for a loss that was not a restart, however short", () => {
		expect(readsConnected("reconnecting", true, false)).toBe(false);
		expect(readsConnected("reconnecting", false, true)).toBe(false);
		expect(readsConnected("reconnecting", false, false)).toBe(false);
	});

	it("is connected whenever the connection is", () => {
		expect(readsConnected("connected", false, false)).toBe(true);
		expect(readsConnected("connected", true, false)).toBe(true);
	});

	it("is not connected for a document that was refused, deleted or closed, whatever else is said", () => {
		for (let status of ["denied", "deleted", "closed"]) {
			expect(readsConnected(status, false, true)).toBe(false);
		}
	});
});

describe("refusalOf", () => {
	it("takes a 4xx as a refusal only when Chopin marked it", () => {
		for (let status of [400, 403, 404, 429]) {
			expect(refusalOf(status, true)).toBe("denied");
			expect(refusalOf(status, false)).toBeUndefined();
		}
	});

	it("takes a 401 as a request to sign in, marked or not", () => {
		expect(refusalOf(401, true)).toBe("authentication");
		expect(refusalOf(401, false)).toBe("authentication");
	});

	it("never takes anything but a 4xx for a refusal, so a proxy's 502 or an open door retries", () => {
		for (let status of [200, 204, 302, 500, 502, 503, 504]) {
			expect(refusalOf(status, true)).toBeUndefined();
			expect(refusalOf(status, false)).toBeUndefined();
		}
	});
});

describe("runningBuild", () => {
	it("is the entry script's address, and nothing where there is no page or no script", () => {
		let page = (src: string | null) => ({
			querySelector: () => src === null ? null : { getAttribute: () => src },
		});
		expect(runningBuild(page("/assets/index-AbCd1234.js"))).toBe("/assets/index-AbCd1234.js");
		expect(runningBuild(page(null))).toBeUndefined();
		expect(runningBuild(undefined)).toBeUndefined();
	});
});
