import { describe, expect, test } from "bun:test";
import { BuildReadiness, judgeBuildable, looksBuildable, withoutCallouts } from "./readiness";

import type { JevRequest, JevResult } from "../conversation-plan/jev";
import type { DocumentTarget } from "../plan/service";

let long = `# Title\n\n## Goal\n\n${"word ".repeat(130)}\n\n## Steps\n\nDo it.`;

function target(source: string, revision = 1): DocumentTarget {
	return { channelId: "doc", revision, source, sourceHash: String(revision) };
}

function jev(noul: number, seen: JevRequest[] = []) {
	return async (request: JevRequest): Promise<JevResult> => {
		seen.push(request);
		return {
			model: "test",
			answers: { build_ready: { type: "noul", noul } },
			usage: { input_tokens: 1, output_tokens: 1 },
			latencyMs: 0,
		};
	};
}

function timers() {
	let queue: Array<{ delay: number; action: () => void; cancelled: boolean }> = [];
	return {
		queue,
		after(delay: number, action: () => void) {
			let entry = { delay, action, cancelled: false };
			queue.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		fire() {
			for (let entry of queue.splice(0)) if (!entry.cancelled) entry.action();
		},
	};
}

describe("looksBuildable", () => {
	test("needs enough words and two headings", () => {
		expect(looksBuildable(long)).toBe(true);
		expect(looksBuildable(`# One\n\n${"word ".repeat(200)}`)).toBe(false);
		expect(looksBuildable("# One\n\n## Two\n\nShort.")).toBe(false);
		expect(looksBuildable("")).toBe(false);
	});
});

describe("judgeBuildable", () => {
	test("asks Jev one noul question about the document", async () => {
		let seen: JevRequest[] = [];
		expect(await judgeBuildable("tiny", jev(0.9, seen))).toBe(true);
		expect(Object.keys(seen[0]!.questions)).toEqual(["build_ready"]);
		expect(seen[0]!.questions.build_ready!.type).toBe("noul");
		expect(await judgeBuildable(long, jev(0.2))).toBe(false);
	});

	test("falls back to the heuristic when Jev fails or is absent", async () => {
		let failing = async () => {
			throw new Error("Jev API key is not configured");
		};
		expect(await judgeBuildable(long, failing)).toBe(true);
		expect(await judgeBuildable("tiny", failing)).toBe(false);
		expect(await judgeBuildable(long)).toBe(true);
	});
});

describe("BuildReadiness", () => {
	test("judges once edits settle and reports a change", async () => {
		let clock = timers();
		let source = "tiny";
		let revision = 1;
		let changes: boolean[] = [];
		let asks: JevRequest[] = [];
		let readiness = new BuildReadiness({
			current: async () => target(source, revision),
			ask: jev(0, asks),
			after: clock.after,
			changed: (_id, _revision, ready) => changes.push(ready),
		});
		readiness.schedule(target(source, 1));
		readiness.schedule(target(source, 1));
		expect(clock.queue.map(entry => entry.delay)).toEqual([10_000, 10_000]);
		expect(clock.queue[0]!.cancelled).toBe(true);
		clock.fire();
		await Bun.sleep(0);
		expect(asks.length).toBe(1);
		expect(readiness.ready("doc", 1)).toBe(false);
		expect(changes).toEqual([false]);
	});

	test("reads trigger a judgement and keep the last one until the next arrives", async () => {
		let clock = timers();
		let noul = 0.9;
		let revision = 1;
		let source = long;
		let changes: boolean[] = [];
		let readiness = new BuildReadiness({
			current: async () => target(source, revision),
			ask: request => jev(noul)(request),
			after: clock.after,
			changed: (_id, _revision, ready) => changes.push(ready),
		});
		expect(readiness.ready("doc", 1)).toBe(false);
		await Bun.sleep(0);
		expect(readiness.ready("doc", 1)).toBe(true);
		revision = 2;
		noul = 0.1;
		source = `${long}\n\nMore detail.`;
		readiness.schedule(target(source, 2));
		// Pending: the previous judgement stands and no new one starts early.
		expect(readiness.ready("doc", 2)).toBe(true);
		clock.fire();
		await Bun.sleep(0);
		expect(readiness.ready("doc", 2)).toBe(false);
		expect(changes).toEqual([true, false]);
	});

	test("callout-only edits keep the last verdict without asking again", async () => {
		let asks: JevRequest[] = [];
		let noul = 0.9;
		let revision = 1;
		let source = long;
		let changes: boolean[] = [];
		let readiness = new BuildReadiness({
			current: async () => target(source, revision),
			ask: request => jev(noul, asks)(request),
			changed: (_id, _revision, ready) => changes.push(ready),
		});
		readiness.ready("doc", 1);
		await Bun.sleep(0);
		expect(readiness.ready("doc", 1)).toBe(true);
		noul = 0.1;
		revision = 2;
		source = long.replace(
			"## Steps",
			'<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note">\n\tPrototyping…\n</Callout>\n\n## Steps',
		);
		readiness.ready("doc", 2);
		await Bun.sleep(0);
		expect(readiness.ready("doc", 2)).toBe(true);
		expect(asks).toHaveLength(1);
		expect(JSON.stringify(asks[0]!.state)).not.toContain("Callout");
		expect(changes).toEqual([true]);
	});

	test("strips top-level callouts from the judged source", () => {
		let source = 'Intro.\n\n<Callout type="note">\n\tA spike.\n</Callout>\n\nOutro.\n';
		let stripped = withoutCallouts(source);
		expect(stripped).toContain("Intro.");
		expect(stripped).toContain("Outro.");
		expect(stripped).not.toContain("Callout");
		expect(withoutCallouts(source)).toBe(withoutCallouts("Intro.\n\nOutro.\n"));
	});

	test("without Jev, the heuristic decides", async () => {
		let readiness = new BuildReadiness({ current: async () => target(long) });
		readiness.ready("doc", 1);
		await Bun.sleep(0);
		expect(readiness.ready("doc", 1)).toBe(true);
	});

	test("close cancels a pending judgement", () => {
		let clock = timers();
		let readiness = new BuildReadiness({ current: async () => target(long), after: clock.after });
		readiness.schedule(target(long));
		readiness.close();
		expect(clock.queue[0]!.cancelled).toBe(true);
	});

	test("skipped documents are never judged", async () => {
		let asks: JevRequest[] = [];
		let readiness = new BuildReadiness({
			current: async () => target(long),
			ask: jev(1, asks),
			skip: () => true,
		});
		expect(readiness.ready("doc", 1)).toBe(false);
		await Bun.sleep(0);
		expect(asks.length).toBe(0);
	});

	test("caps remembered judgements", async () => {
		let readiness = new BuildReadiness({
			current: async id => ({ ...target(long), channelId: id }),
			limit: 2,
		});
		for (let id of ["a", "b", "c"]) {
			readiness.ready(id, 1);
			await Bun.sleep(0);
		}
		expect(readiness.ready("c", 1)).toBe(true);
		expect(readiness.ready("a", 1)).toBe(false);
	});

	test("a judgement requested mid-run runs again afterwards", async () => {
		let revision = 1;
		let source = long;
		let gate: (() => void) | undefined;
		let asks = 0;
		let readiness = new BuildReadiness({
			current: async () => target(source, revision),
			ask: async request => {
				asks++;
				if (asks === 1) await new Promise<void>(resolve => (gate = resolve));
				return jev(0.9)(request);
			},
		});
		readiness.ready("doc", 1);
		await Bun.sleep(0);
		revision = 2;
		source = `${long}\n\nMore detail.`;
		readiness.ready("doc", 2);
		gate!();
		await Bun.sleep(5);
		expect(asks).toBe(2);
		expect(readiness.ready("doc", 2)).toBe(true);
	});

	test("forwards Jev errors before falling back", async () => {
		let errors: unknown[] = [];
		let failing = async (): Promise<JevResult> => {
			throw new Error("down");
		};
		expect(await judgeBuildable(long, failing, err => errors.push(err))).toBe(true);
		expect(errors.length).toBe(1);
	});
});
