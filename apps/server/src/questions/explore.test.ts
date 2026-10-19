import { expect, test } from "bun:test";
import * as Explore from "./explore";
import { normalizeRecord } from "./records";
import { member, opened, restart, seed } from "./text-response.test-fixtures";

import type { ExploreDeps } from "./explore";

const KEY = "0b7a8f8e-4a1c-4e8e-9d2f-1c3b5a7d9e01";
const REF = "7c2d4e6f-8a0b-4c1d-9e2f-3a4b5c6d7e8f";

function deps(overrides: Partial<ExploreDeps> = {}) {
	let notices: string[] = [];
	let stopped: string[] = [];
	let value: ExploreDeps = {
		research: async () => true,
		spike: async () => true,
		stop: async (_room, finding) => {
			stopped.push(finding.id);
		},
		notice: async (_plan, _room, _id, text) => {
			notices.push(text);
		},
		...overrides,
	};
	return { deps: value, notices, stopped };
}

test("records keep findings within bounds and reject unknown or malformed fields", () => {
	let value = seed();
	let finding = {
		id: KEY,
		kind: "research",
		status: "ready",
		ref: REF,
		title: "Inferring needs no new storage",
		sources: [{ title: "Where state could live", url: "https://example.com/a" }],
		sourceCount: 3,
		by: "ana",
		at: 1,
	};
	expect(normalizeRecord({ ...value.record, findings: [finding] }).findings).toEqual([finding] as never);
	for (
		let invalid of [
			[{ ...finding, kind: "check" }],
			[{ ...finding, status: "done" }],
			[{ ...finding, extra: true }],
			[finding, finding],
			[{ ...finding, sources: [{ title: "x", url: "javascript:alert(1)" }] }],
			[{ ...finding, title: " " }],
			Array.from({ length: 21 }, (_, index) => ({ ...finding, id: `f${index}` })),
		]
	) expect(() => normalizeRecord({ ...value.record, findings: invalid })).toThrow(/invalid/);
});

test("research starts as a running finding that persists, repeats by key, and settles once", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let { deps: explore, notices } = deps();
	let ask = {
		kind: "question:explore",
		ts: 0,
		rid: "r1",
		id: context.id,
		key: KEY,
		action: "research",
		ref: REF,
		focus: "Check whether drop-off happens before the first edit",
	} as const;
	await Explore.explore(context.plan, context.server, context.channel.id, ws, ask, explore);
	expect(frames.at(-1)).toMatchObject({ ok: true, finding: { status: "running", ref: REF } });
	await Explore.explore(context.plan, context.server, context.channel.id, ws, ask, explore);
	expect(frames.at(-1)).toMatchObject({ ok: true, repeated: true });
	expect(context.plan.records.get(context.id)!.findings).toHaveLength(1);

	let plan = await restart(context);
	expect(plan.records.get(context.id)!.findings?.[0]).toMatchObject({ status: "running" });
	let request = {
		id: REF,
		stage: "ready",
		sources: [{ title: "Where state could live", url: "https://example.com/a" }],
		child: {
			id: "child-1",
			title: "Drop-off happens in session two",
			summary: "Most edit once.",
			sourceCount: 6,
		},
	};
	await Explore.settleResearch(plan, context.server, context.channel.id, request, explore.notice);
	await Explore.settleResearch(plan, context.server, context.channel.id, request, explore.notice);
	expect(plan.records.get(context.id)!.findings?.[0]).toMatchObject({
		status: "ready",
		title: "Drop-off happens in session two",
		childId: "child-1",
		sourceCount: 6,
	});
	expect(notices).toEqual(["Research finished for How should onboarding work?"]);
});

test("explore refuses foreign work, invalid keys and settled decisions", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let base = {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "research",
		ref: REF,
	} as const;
	await Explore.explore(context.plan, context.server, context.channel.id, ws, {
		...base,
		key: "not-a-uuid",
	}, deps().deps);
	expect(frames.at(-1)).toMatchObject({ ok: false, reason: "invalid" });
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		base,
		deps({ research: async () => false }).deps,
	);
	expect(frames.at(-1)).toMatchObject({ ok: false, reason: "unavailable" });
	await Explore.explore(context.plan, context.server, context.channel.id, ws, {
		...base,
		id: "missing",
	}, deps().deps);
	expect(frames.at(-1)).toMatchObject({ ok: false, reason: "resolved" });
	expect(context.plan.records.get(context.id)!.findings).toBeUndefined();
});

test("asking posts a notice, and only the asked member can reply", async () => {
	let context = await opened();
	let ana = member("ana");
	let sam = member("sam");
	let { deps: explore, notices } = deps();
	await Explore.explore(context.plan, context.server, context.channel.id, ana.ws, {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "ask",
		login: "sam",
	}, explore);
	expect(notices).toEqual(["@ana asked @sam about How should onboarding work?"]);
	let reply = {
		kind: "question:take",
		ts: 0,
		id: context.id,
		finding: KEY,
		text: "Objects.",
	} as const;
	await Explore.take(context.plan, context.server, context.channel.id, ana.ws, {
		...reply,
		rid: "a",
	});
	expect(ana.frames.at(-1)).toMatchObject({ ok: false });
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		...reply,
		rid: "b",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: true });
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({
		kind: "ask",
		status: "ready",
		summary: "Objects.",
	});
});

test("stopping a running finding stops its work and marks it stopped", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let { deps: explore, stopped } = deps();
	await Explore.explore(context.plan, context.server, context.channel.id, ws, {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "spike",
	}, explore);
	await Explore.stop(context.plan, context.server, context.channel.id, ws, {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	}, explore);
	expect(frames.at(-1)).toMatchObject({ ok: true });
	expect(stopped).toEqual([KEY]);
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({ status: "stopped" });
});
