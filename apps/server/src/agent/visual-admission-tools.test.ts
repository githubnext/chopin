import { afterEach, expect, test } from "bun:test";

import { type DocumentRoom, documentTools } from "./tools";
import { visualExample } from "./visual-catalog";
import { createVisualAdmission } from "./visual-admission";
import * as Edit from "../plan/edit";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

let plans: Awaited<ReturnType<typeof Service.open>>[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function fixture() {
	let opened = await openPlan("# Visual admission\n\nExisting human prose.\n");
	plans.push(opened.plan);
	let published = 0;
	let locked = false;
	let ownerController = new AbortController();
	let owner = { signal: ownerController.signal, revalidate: async () => true };
	let room: DocumentRoom = {
		id: opened.channel.id,
		plan: opened.plan,
		server: opened.server,
		publish: async mutation => {
			published++;
			await Service.publish(opened.plan, opened.server, opened.channel.id, mutation);
		},
		persist: async () => {},
		exclusive: action =>
			Service.exclusive(opened.plan, async () => {
				locked = true;
				try {
					return await action();
				} finally {
					locked = false;
				}
			}),
		anchors: () => {},
		changes: () => {},
	};
	let edit = async (
		operations: Edit.Operation[],
		revision = room.plan.revision,
		abortSignal?: AbortSignal,
	) => {
		let output = await documentTools.edit_plan.execute!({
			revision,
			operations,
		}, { context: { room, owner }, toolCallId: "edit", messages: [], abortSignal } as never);
		if (typeof output !== "string") throw new Error("tool did not return text");
		return JSON.parse(output);
	};
	let call = (source: string, revision = room.plan.revision, signal?: AbortSignal) =>
		edit([{ op: "insert_root", source }], revision, signal);
	return {
		room,
		call,
		edit,
		ownerController,
		get published() {
			return published;
		},
		get locked() {
			return locked;
		},
	};
}

test("refuses new prose before mutation and accepts a visual repair in the same batch", async () => {
	let setup = await fixture();
	let before = Edit.source(setup.room.plan);
	let passage = "The client sends the request to the server, which responds to the client.";
	let sources: string[][] = [];
	let issue = {
		code: "E_VISUAL_REQUIRED",
		path: "sources[0]",
		message: "Add a sequence diagram beside this prose.",
	};
	setup.room.visualAdmission = async input => {
		expect(setup.locked).toBe(false);
		expect(input.before).toBe(before);
		sources.push(input.sources);
		return input.sources.some(source => source.includes("```seecode")) ? [] : [issue];
	};
	expect(await setup.call(passage)).toMatchObject({
		ok: false,
		reason: "visuals-required",
		issues: [issue],
	});
	expect(Edit.source(setup.room.plan)).toBe(before);
	expect(setup.published).toBe(0);
	let repair = `${passage}\n\n\`\`\`seecode\n${JSON.stringify(visualExample("sequence"))}\n\`\`\``;
	expect(await setup.call(repair)).toMatchObject({ ok: true });
	expect(Edit.source(setup.room.plan)).toContain(passage);
	expect(setup.published).toBe(1);
	expect(sources[0]).toHaveLength(1);
	expect(sources[0]![0]).toContain(before.trim());
	expect(sources[0]![0]).toContain(passage);
	expect(sources[1]![0]).toContain("```seecode");
});

test.each(["before-assessment", "during-assessment", "before-apply"])(
	"an edit cancelled %s never mutates or publishes",
	async phase => {
		let setup = await fixture();
		let before = Edit.source(setup.room.plan);
		let committed = setup.room.plan.persistence.committedSource;
		let controller = new AbortController();
		let entered = Promise.withResolvers<void>();
		let finish = Promise.withResolvers<void>();
		let called = false;
		let seen: AbortSignal | undefined;
		setup.room.visualAdmission = async input => {
			called = true;
			seen = input.signal;
			entered.resolve();
			if (phase === "during-assessment") await finish.promise;
			return [];
		};
		let exclusive = setup.room.exclusive;
		let queues = 0;
		setup.room.exclusive = action =>
			exclusive(async () => {
				queues++;
				if (phase === "before-apply" && queues === 3) controller.abort();
				return action();
			});
		if (phase === "before-assessment") controller.abort();
		let pending = setup.call(
			"A passage requiring asynchronous assessment.",
			undefined,
			controller.signal,
		);
		if (phase === "during-assessment") {
			await entered.promise;
			controller.abort();
			finish.resolve();
		}
		expect(await pending).toMatchObject({ ok: false, reason: "cancelled" });
		expect(called).toBe(phase !== "before-assessment");
		if (called) expect(seen?.aborted).toBe(true);
		expect(Edit.source(setup.room.plan)).toBe(before);
		expect(setup.room.plan.persistence.committedSource).toBe(committed);
		expect(setup.published).toBe(0);
	},
);

test.each(["owner", "turn"])(
	"%s cancellation also fences a pending admitted edit",
	async source => {
		let setup = await fixture();
		let before = Edit.source(setup.room.plan);
		let turnController = new AbortController();
		setup.room.turnSignal = () => turnController.signal;
		let entered = Promise.withResolvers<void>();
		let finish = Promise.withResolvers<void>();
		let seen: AbortSignal | undefined;
		setup.room.visualAdmission = async input => {
			seen = input.signal;
			entered.resolve();
			await finish.promise;
			return [];
		};
		let pending = setup.call("A passage that must remain unpublished after cancellation.");
		await entered.promise;
		(source === "owner" ? setup.ownerController : turnController).abort();
		finish.resolve();
		expect(await pending).toMatchObject({ ok: false, reason: "cancelled" });
		expect(seen?.aborted).toBe(true);
		expect(Edit.source(setup.room.plan)).toBe(before);
		expect(setup.published).toBe(0);
	},
);

test("cannot remove or change a required diagram while retaining its passage", async () => {
	let setup = await fixture();
	let passage = "The client sends the request to the server, which responds to the client.";
	let source = `${passage}\n\n\`\`\`seecode\n${JSON.stringify(visualExample("sequence"))}\n\`\`\``;
	expect(await setup.call(source)).toMatchObject({ ok: true });
	let before = Edit.source(setup.room.plan);
	let revision = setup.room.plan.revision;
	let diagram = Edit.outline(setup.room.plan).findLast(block => block.type === "code")!;
	setup.room.visualAdmission = createVisualAdmission(async request => ({
		model: "jev-test",
		answers: Object.fromEntries(
			Object.keys(request.questions).map(key => [
				key,
				key.startsWith("t")
					? { type: "choice", choice: "sequence", confidence: 1, probabilities: {} }
					: { type: "noul", noul: 1 },
			]),
		),
		usage: { input_tokens: 0, output_tokens: 0 },
		latencyMs: 0,
	}));
	expect(await setup.edit([{ op: "delete", index: diagram.index }], revision))
		.toMatchObject({ ok: false, reason: "visuals-required" });
	let replacement = `\`\`\`seecode\n${JSON.stringify(visualExample("flowchart"))}\n\`\`\``;
	expect(await setup.edit([{ op: "replace", index: diagram.index, source: replacement }], revision))
		.toMatchObject({ ok: false, reason: "visuals-required" });
	expect(Edit.source(setup.room.plan)).toBe(before);
	expect(setup.published).toBe(1);
});

test("refuses a revision that changes while asynchronous visual admission runs", async () => {
	let setup = await fixture();
	let entered = Promise.withResolvers<void>();
	let finish = Promise.withResolvers<void>();
	setup.room.visualAdmission = async () => {
		entered.resolve();
		await finish.promise;
		return [];
	};
	let pending = setup.call("The client sends a request to the server.");
	await entered.promise;
	await setup.room.exclusive(async () => {
		let mutation = Edit.apply(setup.room.plan, setup.room.plan.revision, [{
			op: "insert_root",
			source: "A human added this while assessment ran.",
		}]);
		expect(mutation.ok).toBe(true);
		if (mutation.ok && mutation.mutation) {
			await Service.publish(setup.room.plan, setup.room.server, setup.room.id, mutation.mutation);
		}
	});
	finish.resolve();
	expect(await pending).toMatchObject({ ok: false, reason: "stale" });
	expect(Edit.source(setup.room.plan)).not.toContain("The client sends");
	expect(setup.published).toBe(0);
});
