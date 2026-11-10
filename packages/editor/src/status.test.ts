import { describe, expect, test } from "bun:test";

import { announcement, describeStatus } from "./status";

describe("describeStatus", () => {
	test("says nothing while connected and idle", () => {
		expect(describeStatus({ connection: "connected", synced: true }).level).toBe("hidden");
	});

	test("loading and agent work are a quiet dot", () => {
		expect(describeStatus({ connection: "connected", synced: false })).toEqual({
			level: "quiet",
			label: "Loading",
		});
		expect(describeStatus({ connection: "connected", synced: true, busy: true }).level).toBe(
			"quiet",
		);
	});

	test("a first connection is loading, not a loss", () => {
		expect(describeStatus({ connection: "connecting", synced: false }).level).toBe("quiet");
	});

	test("a lost connection is the connection banner's to say, so the header stays quiet", () => {
		for (let connection of ["reconnecting", "connecting"] as const) {
			expect(describeStatus({ connection, synced: true }).level).toBe("hidden");
		}
		expect(describeStatus({ connection: "reconnecting", synced: false }).level).toBe("hidden");
	});

	test("refusal, closure and open failure are alerts with reload", () => {
		for (
			let input of [
				{ connection: "denied" as const, synced: true },
				{ connection: "closed" as const, synced: true },
				{ connection: "connected" as const, synced: false, failed: "Permission denied" },
			]
		) {
			let status = describeStatus(input);
			expect(status.level).toBe("alert");
			expect(status.reload).toBe(true);
			expect(status.detail).toBeTruthy();
		}
	});

	test("a failure keeps its reason in the detail, not the label", () => {
		let status = describeStatus({ synced: false, failed: "Permission denied" });
		expect(status.label).toBe("Could not open");
		expect(status.detail).toBe("Permission denied. Reloading may help.");
	});

	test("connection loss outranks a stale open failure", () => {
		expect(
			describeStatus({ connection: "reconnecting", synced: false, failed: "Permission denied" })
				.level,
		).toBe("hidden");
	});
});

describe("announcement", () => {
	test("opening a document says nothing", () => {
		expect(announcement("quiet", { level: "hidden", label: "Ready" })).toBe("");
		expect(announcement("hidden", { level: "quiet", label: "Loading" })).toBe("");
	});

	test("an alert speaks its label only, not the detail", () => {
		expect(
			announcement("hidden", {
				level: "alert",
				label: "No access",
				detail: "The server refused this connection. Reloading may help.",
			}),
		).toBe("No access");
		expect(announcement("notice", { level: "alert", label: "Disconnected" })).toBe("Disconnected");
	});

	test("leaving an alert is said once as reconnected", () => {
		expect(announcement("alert", { level: "hidden", label: "Ready" })).toBe("Reconnected");
		expect(announcement("notice", { level: "quiet", label: "Loading" })).toBe("Reconnected");
	});
});
