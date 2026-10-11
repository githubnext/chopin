import { afterEach, expect, test } from "bun:test";

import { createChildDocuments } from "../chat/children";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { type DocumentRoom, documentTools } from "./tools";

import type { Plan } from "../plan/service";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

async function rooted(options: { access?: () => Promise<boolean>; focus?: boolean } = {}) {
	let child = await openPlan("# Child report\n\nOriginal finding.\n", { parent: "Root" });
	let root = await openPlan("# Root\n\nRoot prose.\n");
	plans.push(child.plan, root.plan);
	let rootId = child.channel.parentChannelId!;
	let committedAtBroadcast: string[] = [];
	let server = {
		publish(_topic: string, data: string) {
			let frame = JSON.parse(data) as { kind: string };
			if (frame.kind === "plan:update") {
				committedAtBroadcast.push(child.plan.persistence.committedSource);
			}
			child.server.publish(_topic, data);
		},
	} as unknown as typeof child.server;
	let children = createChildDocuments({
		rootId,
		repositoryId: "R_test",
		channels: child.backend.storage.channels,
		server,
		withChildPlan: async (_id, action) => action(child.plan),
	});
	let room: DocumentRoom = {
		id: rootId,
		plan: root.plan,
		server: root.server,
		publish: async () => {
			throw new Error("the root document must not change");
		},
		persist: () => Service.persist(root.plan),
		exclusive: action => Service.exclusive(root.plan, action),
		anchors() {},
		changes() {},
		children,
		currentMemberRequest: () =>
			options.focus
				? {
					entryId: "e",
					userId: "U_ana",
					handle: "ana",
					text: "t",
					claimantSessionId: undefined,
					turnId: "turn",
					lifecycle: 0,
					focus: { channelId: child.channel.id, title: "Test plan" },
				}
				: undefined,
	};
	let owner = {
		signal: new AbortController().signal,
		revalidate: options.access ?? (async () => true),
	};
	let call = async (name: keyof typeof documentTools, input: unknown) => {
		let output = await documentTools[name].execute!(input as never, {
			context: { room, owner, repository: { id: "R_test" } },
			toolCallId: "call",
			messages: [],
		} as never);
		let text = String(output);
		return text.startsWith("Error:") ? text : JSON.parse(text);
	};
	return { child, root, rootId, call, committedAtBroadcast };
}

test("list_children lists the root's children without focus", async () => {
	let { call, child } = await rooted();
	expect((await call("list_children", {})).children).toEqual([
		{ id: child.channel.id, title: "Test plan", createdAt: child.channel.createdAt.toISOString() },
	]);
});

test("list_children marks the child the current member request is focused on", async () => {
	let { call } = await rooted({ focus: true });
	expect((await call("list_children", {})).children[0].focused).toBe(true);
});

test("read_child returns the child's revision, source, and addressable blocks", async () => {
	let { call, child } = await rooted();
	let read = await call("read_child", { child: child.channel.id });
	expect(read.child).toEqual({ id: child.channel.id, title: "Test plan" });
	expect(read.source).toContain("Original finding.");
	expect(read.revision).toBe(child.plan.revision);
	expect(read.blocks.length).toBeGreaterThan(0);
});

test("edit_child commits the child before broadcasting and leaves the root alone", async () => {
	let { call, child, root, committedAtBroadcast } = await rooted();
	let read = await call("read_child", { child: child.channel.id });
	let rootSource = await Service.readCurrentDocument(root.plan);
	let result = await call("edit_child", {
		child: child.channel.id,
		revision: read.revision,
		operations: [{ op: "insert", index: read.blocks.length - 1, source: "Planner note." }],
	});
	expect(result.ok).toBe(true);
	expect(result.child).toBe(child.channel.id);
	expect(child.plan.persistence.committedSource).toContain("Planner note.");
	expect(committedAtBroadcast).toHaveLength(1);
	expect(committedAtBroadcast[0]).toContain("Planner note.");
	expect(await Service.readCurrentDocument(root.plan)).toEqual(rootSource);
});

test("edit_child refuses a stale revision and writes nothing", async () => {
	let { call, child, committedAtBroadcast } = await rooted();
	let before = child.plan.persistence.committedSource;
	let result = await call("edit_child", {
		child: child.channel.id,
		revision: child.plan.revision + 5,
		operations: [{ op: "insert_root", source: "Nope." }],
	});
	expect(result.ok).toBe(false);
	expect(child.plan.persistence.committedSource).toBe(before);
	expect(committedAtBroadcast).toEqual([]);
});

test("edit_child refuses once the root is archived while the edit waits its turn", async () => {
	let { call, child, rootId, committedAtBroadcast } = await rooted();
	let read = await call("read_child", { child: child.channel.id });
	let before = child.plan.persistence.committedSource;
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	let busy = Service.exclusive(child.plan, () => gate);
	let editing = call("edit_child", {
		child: child.channel.id,
		revision: read.revision,
		operations: [{ op: "insert_root", source: "Too late." }],
	});
	await Bun.sleep(10);
	await child.storage.channels.archive({ id: rootId, now: new Date() });
	release();
	await busy;
	expect(await editing).toContain("no such child document");
	expect(child.plan.persistence.committedSource).toBe(before);
	expect(committedAtBroadcast).toEqual([]);
});

test("anchor_child anchors through the child's own persistence and refuses a stale revision", async () => {
	let { call, child } = await rooted();
	let read = await call("read_child", { child: child.channel.id });
	let stale = await call("anchor_child", {
		child: child.channel.id,
		revision: read.revision + 1,
		anchors: [{ thread: "T", blocks: [] }],
	});
	expect(stale).toMatchObject({ ok: false, reason: "stale" });
	let unknown = await call("anchor_child", {
		child: child.channel.id,
		revision: read.revision,
		anchors: [{ thread: "missing", blocks: [] }],
	});
	expect(unknown).toMatchObject({ ok: false, reason: "invalid" });
});

test("child tools refuse the root, a foreign id, a malformed id, and visual routes", async () => {
	let { call, rootId, child } = await rooted();
	for (let target of [rootId, crypto.randomUUID()]) {
		expect(await call("read_child", { child: target })).toContain("no such child document");
	}
	expect(await call("read_child", { child: "../root" })).toContain("`child` must be");
	expect(
		await call("edit_child", {
			child: child.channel.id,
			revision: 0,
			operations: [{ op: "insert_root", source: "x" }],
			visual_route: "r",
		}),
	).toMatchObject({ ok: false, reason: "visual-routing-unavailable" });
});

test("every child tool refuses once the Planner owner loses repository access", async () => {
	let allowed = true;
	let { call, child } = await rooted({ access: async () => allowed });
	let read = await call("read_child", { child: child.channel.id });
	allowed = false;
	let before = child.plan.persistence.committedSource;
	expect(await call("list_children", {})).toContain("repository access could not be confirmed");
	expect(await call("read_child", { child: child.channel.id })).toContain("could not be confirmed");
	expect(
		await call("edit_child", {
			child: child.channel.id,
			revision: read.revision,
			operations: [{ op: "insert_root", source: "x" }],
		}),
	).toContain("could not be confirmed");
	expect(
		await call("anchor_child", {
			child: child.channel.id,
			revision: read.revision,
			anchors: [{ thread: "T", blocks: [] }],
		}),
	).toContain("could not be confirmed");
	expect(child.plan.persistence.committedSource).toBe(before);
});

test("child tools refuse without a Planner owner", async () => {
	let { child, root } = await rooted();
	let opened: string[] = [];
	let children = {
		list: async () => [],
		resolve: async () => undefined,
		open: async (id: string) => opened.push(id),
	};
	let output = await documentTools.read_child.execute!({ child: child.channel.id } as never, {
		context: { room: { id: "x", plan: root.plan, children }, repository: { id: "R_test" } },
		toolCallId: "call",
		messages: [],
	} as never);
	expect(String(output)).toContain("repository access could not be confirmed");
	expect(opened).toEqual([]);
});

test("child tools are unavailable in a room without children", async () => {
	let bare = await openPlan("# Child\n", { parent: "Root" });
	plans.push(bare.plan);
	let output = await documentTools.list_children.execute!({} as never, {
		context: {
			room: { id: bare.channel.id, plan: bare.plan },
			owner: { signal: new AbortController().signal, revalidate: async () => true },
		},
		toolCallId: "call",
		messages: [],
	} as never);
	expect(String(output)).toContain("child documents are unavailable");
});

test("an unexpected storage failure reaches the model as a generic refusal", async () => {
	let { call, child } = await rooted();
	let original = console.error;
	console.error = () => {};
	let list = child.backend.storage.channels.children;
	child.backend.storage.channels.children = async () => {
		throw new Error("connection to 10.0.0.5:5432 refused password=hunter2");
	};
	try {
		let text = await call("list_children", {});
		expect(text).toBe("Error: child documents are temporarily unavailable");
	} finally {
		child.backend.storage.channels.children = list;
		console.error = original;
	}
});
