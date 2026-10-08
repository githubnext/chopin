import { expect, test } from "bun:test";

import { VisualDecisionController } from "./visual-decision-controller";

import type { VisualDecision } from "@chopin/protocol";
import type { Transport } from "./transport";

function state(revision = 0, optionPadding: 4 | 6 | 8 = 6): VisualDecision.State {
	return {
		id: "visual-1",
		definition: {
			specimen: "decision-card-v1",
			bundleDigest: `sha256:${"a".repeat(64)}`,
			baseline: { optionPadding: 6, selectedColor: "#E1ECEF" },
			controls: [
				{ id: "optionPadding", type: "number", min: 4, max: 8, step: 2 },
				{ id: "selectedColor", type: "color", format: "#RRGGBB" },
			],
		},
		revision,
		values: { optionPadding, selectedColor: "#E1ECEF" },
	};
}

type Request = {
	kind: string;
	payload: Record<string, unknown>;
	resolve: (result: VisualDecision.Result) => void;
	reject: (error: Error) => void;
};

function setup() {
	let requests: Request[] = [];
	let changed: ((frame: { state: VisualDecision.State }) => void) | undefined;
	let wire: Transport = {
		on: (_kind, listener) => {
			changed = listener as (frame: { state: VisualDecision.State }) => void;
			return () => {};
		},
		send: () => {},
		ask: (kind, payload = {}) => {
			let deferred = Promise.withResolvers<VisualDecision.Result>();
			requests.push({ kind, payload, ...deferred });
			return deferred.promise as Promise<never>;
		},
	};
	let controller = new VisualDecisionController(wire, "visual-1");
	controller.subscribe(() => {});
	controller.configure(true);
	return {
		controller,
		requests,
		changed: (next: VisualDecision.State) => changed?.({ state: next }),
	};
}

async function tick() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function opened() {
	let fixture = setup();
	fixture.requests[0].resolve({ ok: true, state: state() });
	await tick();
	return fixture;
}

test("live accepted state preserves separate controls and ignores older replies", async () => {
	let { controller, changed } = await opened();
	changed(state(1, 8));
	changed({ ...state(2, 8), values: { optionPadding: 8, selectedColor: "#123456" } });
	changed(state(1, 4));
	expect(controller.getSnapshot().state?.values).toEqual({
		optionPadding: 8,
		selectedColor: "#123456",
	});
	expect(controller.getSnapshot().state?.definition.baseline.optionPadding).toBe(6);
});

test("a broadcast cannot remove an edit before its own acknowledgement", async () => {
	let { controller, requests, changed } = await opened();
	controller.change({ optionPadding: 8 });
	controller.change({ selectedColor: "#123456" });
	changed(state(1, 8));
	expect(controller.getSnapshot().pending).toBe(2);
	expect(requests).toHaveLength(2);
	requests[1].resolve({ ok: true, state: state(1, 8) });
	await tick();
	expect(controller.getSnapshot().pending).toBe(1);
	expect(requests[2].payload.patch).toEqual({ selectedColor: "#123456" });
	let firstKey = String(requests[1].payload.key);
	let secondKey = String(requests[2].payload.key);
	expect(firstKey.slice(0, 36)).toBe(secondKey.slice(0, 36));
	expect(firstKey.endsWith(":1")).toBe(true);
	expect(secondKey.endsWith(":2")).toBe(true);
});

test("disconnect retains an unacknowledged edit and opens before replay with the same key", async () => {
	let { controller, requests } = await opened();
	controller.change({ optionPadding: 8 });
	let original = requests[1];
	controller.configure(false);
	original.reject(new Error("connection lost"));
	await tick();
	expect(controller.getSnapshot().pending).toBe(1);
	controller.configure(true);
	expect(requests[2].kind).toBe("visual-decision:open");
	requests[2].resolve({ ok: true, state: state(2, 4) });
	await tick();
	expect(requests[3].kind).toBe("visual-decision:edit");
	expect(requests[3].payload.key).toBe(original.payload.key);
	requests[3].resolve({ ok: true, state: state(2, 4) });
	await tick();
	expect(controller.getSnapshot().pending).toBe(0);
	expect(controller.getSnapshot().state?.values.optionPadding).toBe(4);
});

test("Save waits for local acknowledgements and claims the accepted revision", async () => {
	let { controller, requests } = await opened();
	controller.change({ optionPadding: 8 });
	await controller.save();
	expect(requests).toHaveLength(2);
	requests[1].resolve({ ok: true, state: state(1, 8) });
	await tick();
	let saving = controller.save();
	expect(requests[2].payload).toEqual({ id: "visual-1", revision: 1 });
	controller.change({ optionPadding: 4 });
	expect(requests).toHaveLength(3);
	requests[2].resolve({ ok: false, reason: "stale", state: state(2, 4) });
	await saving;
	expect(controller.getSnapshot().state?.revision).toBe(2);
	expect(controller.getSnapshot().error).toContain("Review the latest values");
	let retry = controller.save();
	expect(requests[3].payload.revision).toBe(2);
	requests[3].reject(new Error("commit failed"));
	await retry;
	expect(controller.getSnapshot().saving).toBe(false);
	expect(controller.getSnapshot().error).toContain("Try again");
	controller.change({ optionPadding: 8 });
	expect(requests[4].kind).toBe("visual-decision:edit");
});

test("failed edits remain available for explicit retry and newer state clears errors", async () => {
	let { controller, requests, changed } = await opened();
	controller.change({ optionPadding: 8 });
	requests[1].reject(new Error("commit failed"));
	await tick();
	expect(controller.getSnapshot().pending).toBe(1);
	expect(controller.getSnapshot().error).toContain("waiting to sync");
	changed(state(1, 4));
	expect(controller.getSnapshot().error).toBeUndefined();
	controller.retry();
	expect(requests[2].payload.key).toBe(requests[1].payload.key);
	requests[2].resolve({ ok: true, state: state(2, 8) });
	await tick();
	expect(controller.getSnapshot().pending).toBe(0);
});

test("a saved broadcast is terminal even if an older open reply has the same revision", async () => {
	let { controller, requests, changed } = setup();
	let saved = state(2, 8);
	saved.saved = {
		revision: 2,
		values: { ...saved.values },
		by: "maggie",
		at: "2026-10-08T12:00:00Z",
	};
	changed(saved);
	requests[0].resolve({ ok: true, state: state(2, 8) });
	await tick();
	expect(controller.getSnapshot().state?.saved?.by).toBe("maggie");
	controller.change({ optionPadding: 4 });
	await controller.save();
	expect(requests).toHaveLength(1);
});

test("Reset changes the shared controls to the immutable baseline", async () => {
	let { controller, requests, changed } = await opened();
	changed({ ...state(1, 8), values: { optionPadding: 8, selectedColor: "#123456" } });
	controller.reset();
	expect(requests[1].payload.patch).toEqual({ optionPadding: 6, selectedColor: "#E1ECEF" });
});
