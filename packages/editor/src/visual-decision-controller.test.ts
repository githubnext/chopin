import { expect, test } from "bun:test";

import { VisualDecisionController } from "./visual-decision-controller";

import type { VisualDecision } from "@chopin/protocol";
import type { Transport } from "./transport";

function state(revision = 0, spacing: 4 | 6 | 8 = 6): VisualDecision.State {
	return {
		id: "visual-1",
		definition: {
			schema: "visual-decision@1",
			title: "Spacing and accent",
			requestId: "request-1",
			artifact: { ref: "asset-1", digest: `sha256:${"a".repeat(64)}` },
			definitionRevision: `sha256:${"b".repeat(64)}`,
			baseline: { spacing: 6, accent: "#E1ECEF" },
			controls: [
				{ id: "spacing", type: "number", label: "Spacing", unit: "px", min: 4, max: 8, step: 2 },
				{ id: "accent", type: "color", label: "Accent" },
			],
		},
		revision,
		values: { spacing, accent: "#E1ECEF" },
	};
}

function savedChoice(value: VisualDecision.State, by: string): VisualDecision.Saved {
	return {
		decisionId: value.id,
		requestId: value.definition.requestId,
		definitionRevision: value.definition.definitionRevision,
		artifactDigest: value.definition.artifact.digest,
		revision: value.revision,
		values: { ...value.values },
		by,
		at: "2026-10-08T12:00:00Z",
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
	let hello: (() => void) | undefined;
	let wire: Transport = {
		on: (kind, listener) => {
			if (kind === "visual-decision:changed") {
				changed = listener as (frame: { state: VisualDecision.State }) => void;
			} else if (kind === "session:hello") {
				hello = listener as () => void;
			}
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
		hello: () => hello?.(),
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
	changed({ ...state(2, 8), values: { spacing: 8, accent: "#123456" } });
	changed(state(1, 4));
	expect(controller.getSnapshot().state?.values).toEqual({
		spacing: 8,
		accent: "#123456",
	});
	expect(controller.getSnapshot().state?.definition.baseline.spacing).toBe(6);
});

test("a broadcast cannot remove an edit before its own acknowledgement", async () => {
	let { controller, requests, changed } = await opened();
	controller.change({ spacing: 8 });
	controller.change({ accent: "#123456" });
	changed(state(1, 8));
	expect(controller.getSnapshot().pending).toBe(2);
	expect(requests).toHaveLength(2);
	requests[1].resolve({ ok: true, state: state(1, 8) });
	await tick();
	expect(controller.getSnapshot().pending).toBe(1);
	expect(requests[2].payload.patch).toEqual({ accent: "#123456" });
	let firstKey = String(requests[1].payload.key);
	let secondKey = String(requests[2].payload.key);
	expect(firstKey.slice(0, 36)).toBe(secondKey.slice(0, 36));
	expect(firstKey.endsWith(":1")).toBe(true);
	expect(secondKey.endsWith(":2")).toBe(true);
});

test("disconnect retains an unacknowledged edit and opens before replay with the same key", async () => {
	let { controller, requests } = await opened();
	controller.change({ spacing: 8 });
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
	expect(controller.getSnapshot().state?.values.spacing).toBe(4);
});

test("Save waits for local acknowledgements and claims the accepted revision", async () => {
	let { controller, requests } = await opened();
	controller.change({ spacing: 8 });
	await controller.save();
	expect(requests).toHaveLength(2);
	requests[1].resolve({ ok: true, state: state(1, 8) });
	await tick();
	let saving = controller.save();
	expect(requests[2].payload).toEqual({
		id: "visual-1",
		revision: 1,
		definitionRevision: state().definition.definitionRevision,
	});
	controller.change({ spacing: 4 });
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
	controller.change({ spacing: 8 });
	expect(requests[4].kind).toBe("visual-decision:edit");
});

test("a peer update keeps failed local edits actionable until explicit retry succeeds", async () => {
	let { controller, requests, changed } = await opened();
	controller.change({ spacing: 8 });
	requests[1].reject(new Error("commit failed"));
	await tick();
	expect(controller.getSnapshot().pending).toBe(1);
	expect(controller.getSnapshot().error).toContain("waiting to sync");
	changed({ ...state(1), values: { spacing: 6, accent: "#123456" } });
	expect(controller.getSnapshot().state?.values.accent).toBe("#123456");
	expect(controller.getSnapshot().pending).toBe(1);
	expect(controller.getSnapshot().error).toContain("waiting to sync");
	await controller.save();
	expect(requests).toHaveLength(2);
	controller.retry();
	expect(requests[2].payload.key).toBe(requests[1].payload.key);
	expect(requests[2].payload.patch).toEqual({ spacing: 8 });
	requests[2].resolve({
		ok: true,
		state: { ...state(2, 8), values: { spacing: 8, accent: "#123456" } },
	});
	await tick();
	expect(controller.getSnapshot().pending).toBe(0);
	expect(controller.getSnapshot().error).toBeUndefined();
	let saving = controller.save();
	expect(requests[3].payload.revision).toBe(2);
	let accepted = controller.getSnapshot().state!;
	requests[3].resolve({
		ok: true,
		state: {
			...accepted,
			saved: savedChoice(accepted, "ana"),
		},
	});
	await saving;
});

test("a new socket admission reopens a shared controller before replaying its unacknowledged edit", async () => {
	let { controller, requests, hello } = await opened();
	controller.subscribe(() => {});
	controller.change({ spacing: 8 });
	let key = requests[1].payload.key;
	requests[1].reject(new Error("connection lost"));
	await tick();
	hello();
	expect(requests).toHaveLength(3);
	expect(requests[2].kind).toBe("visual-decision:open");
	expect(controller.getSnapshot().pending).toBe(1);
	requests[2].resolve({ ok: true, state: state(1, 4) });
	await tick();
	expect(requests[3].kind).toBe("visual-decision:edit");
	expect(requests[3].payload.key).toBe(key);
	requests[3].resolve({ ok: true, state: state(1, 4) });
	await tick();
	expect(controller.getSnapshot().state?.values.spacing).toBe(4);
	expect(controller.getSnapshot().pending).toBe(0);
	expect(controller.getSnapshot().error).toBeUndefined();
});

test("a saved broadcast is terminal even if an older open reply has the same revision", async () => {
	let { controller, requests, changed } = setup();
	let saved = state(2, 8);
	saved.saved = savedChoice(saved, "maggie");
	changed(saved);
	requests[0].resolve({ ok: true, state: state(2, 8) });
	await tick();
	expect(controller.getSnapshot().state?.saved?.by).toBe("maggie");
	controller.change({ spacing: 4 });
	await controller.save();
	expect(requests).toHaveLength(1);
});

test("Reset changes the shared controls to the immutable baseline", async () => {
	let { controller, requests, changed } = await opened();
	changed({ ...state(1, 8), values: { spacing: 8, accent: "#123456" } });
	controller.reset();
	expect(requests[1].payload.patch).toEqual({ spacing: 6, accent: "#E1ECEF" });
});
