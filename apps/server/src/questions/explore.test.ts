import { expect, test } from "bun:test";
import * as Explore from "./explore";
import { normalizeRecord } from "./records";
import { findings } from "./record-validation";
import { member, opened, restart, seed } from "./text-response.test-fixtures";

import * as Service from "../plan/service";
import type { ExploreDeps, ResearchSnapshot } from "./explore";

const KEY = "0b7a8f8e-4a1c-4e8e-9d2f-1c3b5a7d9e01";
const REF = "7c2d4e6f-8a0b-4c1d-9e2f-3a4b5c6d7e8f";

function deps(overrides: Partial<ExploreDeps> = {}) {
	let notices: string[] = [];
	let stopped: string[] = [];
	let value: ExploreDeps = {
		research: async (_room, ref) => ({ id: ref, stage: "evidence", sources: [] }),
		spike: async (_room, ref) => ({ id: ref, state: "running" }),
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
	expect(normalizeRecord({ ...value.record, findings: [finding] }).findings).toEqual(
		[finding] as never,
	);
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
		deps({ research: async () => undefined }).deps,
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

test("a take carries an optional stance, and only the two known ones", async () => {
	let context = await opened();
	let sam = member("sam");
	await Explore.explore(context.plan, context.server, context.channel.id, member("ana").ws, {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "ask",
		login: "sam",
	}, deps().deps);
	let reply = {
		kind: "question:take",
		ts: 0,
		id: context.id,
		finding: KEY,
		text: "Support resets get hard.",
	} as const;
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		...reply,
		rid: "a",
		stance: "maybe",
	} as never);
	expect(sam.frames.at(-1)).toMatchObject({ ok: false });
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({ status: "running" });
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		...reply,
		rid: "b",
		stance: "objects",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: true });
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({
		status: "ready",
		stance: "objects",
	});
	let plan = await restart(context);
	expect(plan.records.get(context.id)!.findings?.[0]).toMatchObject({ stance: "objects" });
});

test("a stance is valid only on an ask finding, and only as supports or objects", () => {
	let base = { id: "f", status: "ready", ref: "sam", by: "ana", at: 1 };
	expect(findings([{ ...base, kind: "ask", stance: "supports" }])).toHaveLength(1);
	expect(() => findings([{ ...base, kind: "ask", stance: "neutral" }])).toThrow();
	expect(() => findings([{ ...base, kind: "research", stance: "supports" }])).toThrow();
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

test("a decision opens as one page: created once, then remembered on its record", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let created: string[] = [];
	let create = async (input: { recordId: string; title: string }) => {
		created.push(input.title);
		return `child-${input.recordId}`;
	};
	let ask = { kind: "question:page", ts: 0, rid: "p", id: context.id } as const;
	await Explore.page(context.plan, context.server, context.channel.id, ws, ask, create);
	expect(frames.at(-1)).toMatchObject({ ok: true, childId: `child-${context.id}` });
	await Explore.page(context.plan, context.server, context.channel.id, ws, ask, create);
	expect(created).toEqual(["How should onboarding work?"]);
	let plan = await restart(context);
	expect(plan.records.get(context.id)!.childId).toBe(`child-${context.id}`);
	await Explore.page(context.plan, context.server, context.channel.id, ws, {
		...ask,
		id: "missing",
	}, create);
	expect(frames.at(-1)).toMatchObject({ ok: false });
});

const READY: ResearchSnapshot = {
	id: REF,
	stage: "ready",
	sources: [{ title: "Where state could live", url: "https://example.com/a" }],
	child: { id: "child-1", title: "Drop-off happens in session two", summary: "", sourceCount: 2 },
};

function research(context: Awaited<ReturnType<typeof opened>>, key = KEY) {
	return {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key,
		action: "research",
		ref: REF,
	} as const;
}

function status(context: Awaited<ReturnType<typeof opened>>, index = 0) {
	return context.plan.records.get(context.id)!.findings?.[index]?.status;
}

test("attaching work that already ended settles the finding at once", async () => {
	let context = await opened();
	let { ws } = member();
	let { deps: explore, notices } = deps({ research: async () => READY });
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		explore,
	);
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({
		status: "ready",
		childId: "child-1",
	});
	expect(notices).toHaveLength(1);
	let cancelled = deps({
		research: async () => ({ ...READY, stage: "cancelled", child: undefined }),
	});
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context, "1b7a8f8e-4a1c-4e8e-9d2f-1c3b5a7d9e02"),
		cancelled.deps,
	);
	expect(status(context, 1)).toBe("stopped");
	let spiked = deps({ spike: async (_room, ref) => ({ id: ref, state: "failed" }) });
	await Explore.explore(context.plan, context.server, context.channel.id, ws, {
		...research(context),
		key: "2b7a8f8e-4a1c-4e8e-9d2f-1c3b5a7d9e03",
		action: "spike",
	}, spiked.deps);
	expect(status(context, 2)).toBe("failed");
});

test("a failed request that is retried to ready updates its finding", async () => {
	let context = await opened();
	let { deps: explore } = deps();
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		member().ws,
		research(context),
		explore,
	);
	await Explore.settleResearch(context.plan, context.server, context.channel.id, {
		id: REF,
		stage: "failed",
		sources: [],
	}, explore.notice);
	expect(status(context)).toBe("failed");
	await Explore.settleResearch(
		context.plan,
		context.server,
		context.channel.id,
		READY,
		explore.notice,
	);
	expect(status(context)).toBe("ready");
});

test("the sweep settles finished work and skips quietly when nothing runs", async () => {
	let context = await opened();
	let { deps: explore } = deps();
	await Explore.sweep(context.plan, context.server, context.channel.id, explore);
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		member().ws,
		research(context),
		explore,
	);
	await Explore.sweep(context.plan, context.server, context.channel.id, explore);
	expect(status(context)).toBe("running");
	let finished = deps({ research: async () => READY }).deps;
	await Explore.sweep(context.plan, context.server, context.channel.id, finished);
	expect(status(context)).toBe("ready");
	let broken = deps({
		research: async () => {
			throw new Error("down");
		},
	}).deps;
	await Explore.sweep(context.plan, context.server, context.channel.id, broken);
	expect(status(context)).toBe("ready");
});

async function ask(context: Awaited<ReturnType<typeof opened>>, login = "sam") {
	await Explore.explore(context.plan, context.server, context.channel.id, member("ana").ws, {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "ask",
		login,
	}, deps().deps);
}

test("a take needs a running ask on an open decision, matches logins loosely, and settles once", async () => {
	let context = await opened();
	await ask(context, "Sam");
	let sam = member("sam");
	let reply = { kind: "question:take", ts: 0, id: context.id, finding: KEY, text: "Yes." } as const;
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		...reply,
		rid: "a",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: true });
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		...reply,
		rid: "b",
		text: "Changed.",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: false });
	expect(context.plan.records.get(context.id)!.findings?.[0]).toMatchObject({ summary: "Yes." });
});

test("a take after the ask was stopped is refused", async () => {
	let context = await opened();
	await ask(context);
	let ana = member("ana");
	await Explore.stop(context.plan, context.server, context.channel.id, ana.ws, {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	}, deps().deps);
	let sam = member("sam");
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		kind: "question:take",
		ts: 0,
		rid: "t",
		id: context.id,
		finding: KEY,
		text: "Late.",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: false });
	expect(status(context)).toBe("stopped");
});

test("a take on a discarded decision is refused", async () => {
	let context = await opened();
	await ask(context);
	let record = context.plan.records.get(context.id)!;
	context.plan.records = new Map(context.plan.records).set(context.id, {
		...record,
		status: "discarded",
	});
	let sam = member("sam");
	await Explore.take(context.plan, context.server, context.channel.id, sam.ws, {
		kind: "question:take",
		ts: 0,
		rid: "t",
		id: context.id,
		finding: KEY,
		text: "Late.",
	});
	expect(sam.frames.at(-1)).toMatchObject({ ok: false });
	expect(status(context)).toBe("running");
});

test("only the person who started a finding may stop it", async () => {
	let context = await opened();
	await ask(context);
	let { deps: explore } = deps();
	let stop = {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	} as const;
	let sam = member("sam");
	await Explore.stop(context.plan, context.server, context.channel.id, sam.ws, stop, explore);
	expect(sam.frames.at(-1)).toMatchObject({ ok: false });
	expect(status(context)).toBe("running");
	let ana = member("ANA");
	await Explore.stop(context.plan, context.server, context.channel.id, ana.ws, stop, explore);
	expect(ana.frames.at(-1)).toMatchObject({ ok: true });
	expect(status(context)).toBe("stopped");
});

test("a failed persist rolls back and announces nothing, and a retry commits once", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let { deps: explore } = deps();
	let original = context.storage.collaboration.commit;
	let before = context.broadcasts.length;
	(context.storage.collaboration as { commit: typeof original }).commit = async () => {
		throw new Error("storage unavailable");
	};
	try {
		await Explore.explore(
			context.plan,
			context.server,
			context.channel.id,
			ws,
			research(context),
			explore,
		);
	} finally {
		(context.storage.collaboration as { commit: typeof original }).commit = original;
	}
	expect(frames.at(-1)).toMatchObject({ kind: "session:error", message: "storage unavailable" });
	expect(context.plan.records.get(context.id)!.findings).toBeUndefined();
	expect(context.broadcasts).toHaveLength(before);
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		explore,
	);
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		explore,
	);
	expect(frames.at(-1)).toMatchObject({ ok: true, repeated: true });
	expect(context.plan.records.get(context.id)!.findings).toHaveLength(1);
});

test("a full list drops the oldest research first and never a take", async () => {
	let context = await opened();
	let key = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
	let record = context.plan.records.get(context.id)!;
	let base = { status: "ready", by: "ana", at: 1 } as const;
	let take = { ...base, id: "take", kind: "ask", ref: "sam", summary: "Yes." } as const;
	let rest = Array.from({ length: 19 }, (_, index) => ({
		...base,
		id: `r${index}`,
		kind: "research",
		ref: key(index),
	} as const));
	context.plan.records = new Map(context.plan.records).set(context.id, {
		...record,
		findings: [take, ...rest],
	});
	let { ws } = member();
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		deps().deps,
	);
	let list = context.plan.records.get(context.id)!.findings!;
	expect(list).toHaveLength(20);
	expect(list[0]!.id).toBe("take");
	expect(list.some(value => value.id === "r0")).toBe(false);
	// A list of takes and running work has nothing to give up.
	context.plan.records = new Map(context.plan.records).set(context.id, {
		...record,
		findings: Array.from({ length: 20 }, (_, index) => ({ ...take, id: `t${index}` })),
	});
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context, "3b7a8f8e-4a1c-4e8e-9d2f-1c3b5a7d9e04"),
		deps().deps,
	);
	expect(context.plan.records.get(context.id)!.findings).toHaveLength(20);
});

test("stop and page refuse while an implementation is active", async () => {
	let context = await opened();
	await ask(context);
	context.plan.claiming = true;
	let ana = member("ana");
	await Explore.stop(context.plan, context.server, context.channel.id, ana.ws, {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	}, deps().deps);
	expect(ana.frames.at(-1)).toMatchObject({ ok: false });
	await Explore.page(context.plan, context.server, context.channel.id, ana.ws, {
		kind: "question:page",
		ts: 0,
		rid: "p",
		id: context.id,
	}, async () => "child");
	expect(ana.frames.at(-1)).toMatchObject({ ok: false });
	expect(Service.implementationActive(context.plan)).toBe(true);
	expect(status(context)).toBe("running");
});

test("stopping a finding whose work already failed settles it failed, with a quiet notice", async () => {
	let context = await opened();
	let { ws, frames } = member();
	let { deps: explore } = deps();
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		explore,
	);
	let notices: string[] = [];
	let ended = deps({
		research: async () => ({ id: REF, stage: "failed", sources: [] }),
		stop: async () => {
			throw new Error("Research turn is not cancellable.");
		},
		notice: async (_plan, _room, _id, text) => {
			notices.push(text);
		},
	}).deps;
	await Explore.stop(context.plan, context.server, context.channel.id, ws, {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	}, ended);
	expect(frames.at(-1)).toMatchObject({ ok: true });
	expect(status(context)).toBe("failed");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain("didn’t finish");
});

test("a refused cancel still stops the finding, but other errors leave it running", async () => {
	let context = await opened();
	let { ws, frames } = member();
	await Explore.explore(
		context.plan,
		context.server,
		context.channel.id,
		ws,
		research(context),
		deps().deps,
	);
	let stop = {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	} as const;
	let down = deps({
		stop: async () => {
			throw new Error("database down");
		},
	}).deps;
	await Explore.stop(context.plan, context.server, context.channel.id, ws, stop, down);
	expect(frames.at(-1)).toMatchObject({ ok: false });
	expect(status(context)).toBe("running");
	let refused = deps({
		stop: async () => {
			throw new Error("Research turn is not cancellable.");
		},
	}).deps;
	await Explore.stop(context.plan, context.server, context.channel.id, ws, stop, refused);
	expect(frames.at(-1)).toMatchObject({ ok: true });
	expect(status(context)).toBe("stopped");
});

test("stopping an investigation that already failed settles it failed", async () => {
	let context = await opened();
	let { ws } = member();
	await Explore.explore(context.plan, context.server, context.channel.id, ws, {
		kind: "question:explore",
		ts: 0,
		rid: "r",
		id: context.id,
		key: KEY,
		action: "spike",
	}, deps().deps);
	let ended = deps({
		spike: async (_room, ref) => ({ id: ref, state: "failed" }),
		stop: async () => {
			throw new Error("Investigation is not running");
		},
	}).deps;
	await Explore.stop(context.plan, context.server, context.channel.id, ws, {
		kind: "question:explore-stop",
		ts: 0,
		rid: "s",
		id: context.id,
		finding: KEY,
	}, ended);
	expect(status(context)).toBe("failed");
});
