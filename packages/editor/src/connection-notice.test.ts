import { describe, expect, test } from "bun:test";

import {
	CONNECTION_GRACE,
	CONNECTION_STALL,
	connectionNotice,
	isOffline,
	offersRetry,
	offlineAnnouncement,
	RETRY_AFTER_FAILURES,
} from "./connection-notice";

describe("connectionNotice", () => {
	test("says nothing while connected or inside the grace period", () => {
		expect(connectionNotice(undefined)).toBe("none");
		expect(connectionNotice(0)).toBe("none");
		expect(connectionNotice(CONNECTION_GRACE - 1)).toBe("none");
	});

	test("reads as reconnecting, then offline once the loss outlasts the stall", () => {
		expect(connectionNotice(CONNECTION_GRACE)).toBe("reconnecting");
		expect(connectionNotice(CONNECTION_GRACE + CONNECTION_STALL - 1)).toBe("reconnecting");
		expect(connectionNotice(CONNECTION_GRACE + CONNECTION_STALL)).toBe("offline");
	});
});

describe("isOffline", () => {
	test("is an outage once a connection that was lost is being re-established", () => {
		expect(isOffline("reconnecting", true)).toBe(true);
		expect(isOffline("connecting", true)).toBe(true);
	});

	test("follows the outage the connection reports, not only its status", () => {
		// A lost connection can read `connected` while the attempt to learn why is still awaited.
		expect(isOffline("connected", true)).toBe(true);
		expect(isOffline("connected", false)).toBe(false);
	});

	test("is not an outage while connected, or on a first connection that is only slow", () => {
		expect(isOffline("connected", false)).toBe(false);
		expect(isOffline("connecting", false)).toBe(false);
		expect(isOffline("reconnecting", false)).toBe(false);
	});

	test("leaves a refusal or a deleted document to say so for itself", () => {
		expect(isOffline("denied", true)).toBe(false);
		expect(isOffline("deleted", true)).toBe(false);
		expect(isOffline("closed", true)).toBe(false);
	});
});

describe("offersRetry", () => {
	test("offers nothing while automatic reconnects are still working through their backoff", () => {
		expect(offersRetry(0)).toBe(false);
		expect(offersRetry(RETRY_AFTER_FAILURES - 1)).toBe(false);
	});

	test("offers Retry once enough attempts have failed, and keeps offering it", () => {
		expect(offersRetry(RETRY_AFTER_FAILURES)).toBe(true);
		expect(offersRetry(RETRY_AFTER_FAILURES + 20)).toBe(true);
	});
});

describe("offlineAnnouncement", () => {
	test("says nothing as the notice appears, because the notice speaks for itself", () => {
		expect(offlineAnnouncement(false, true)).toBe("");
	});

	test("says once that the connection is back when the notice has gone", () => {
		expect(offlineAnnouncement(true, false)).toBe("Reconnected");
	});

	test("says nothing for a blip that never showed the notice, or while it stays", () => {
		expect(offlineAnnouncement(false, false)).toBe("");
		expect(offlineAnnouncement(true, true)).toBe("");
	});
});
