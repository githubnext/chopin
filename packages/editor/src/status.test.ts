import { describe, expect, test } from "bun:test";

import { describeStatus } from "./status";

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

	test("a lost connection reads as reconnecting, with the detail kept for the tooltip", () => {
		let status = describeStatus({ connection: "reconnecting", synced: true });
		expect(status).toEqual({
			level: "notice",
			label: "Reconnecting…",
			detail: "Editing resumes once connected.",
		});
		expect(describeStatus({ connection: "connecting", synced: true }).level).toBe("notice");
	});

	test("a connection lost for long enough becomes an offline alert with reload", () => {
		let status = describeStatus({ connection: "reconnecting", synced: true, stalled: true });
		expect(status.level).toBe("alert");
		expect(status.label).toBe("Offline");
		expect(status.reload).toBe(true);
		expect(describeStatus({ connection: "connecting", synced: false, stalled: true }).level)
			.toBe("alert");
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
				.label,
		).toBe("Reconnecting…");
	});
});
