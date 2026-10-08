import { describe, expect, test } from "bun:test";

import { CONNECTION_GRACE, CONNECTION_STALL, connectionNotice } from "./connection-notice";

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
