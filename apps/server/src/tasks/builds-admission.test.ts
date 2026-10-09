import { expect, test } from "bun:test";
import * as Y from "yjs";
import { openPlan } from "../testing/plan";
import * as Service from "../plan/service";
import * as Room from "../plan/room";
import * as Edit from "../plan/edit";
import { implementationGraphs } from "./plan-graphs";
import { queueBuild } from "./builds";
import { documentTools } from "../agent/tools";

let task = {
	id: "first",
	title: "First",
	context: "Review",
	goal: "Launch",
	acceptance: ["Starts", "Reports"],
	dependsOn: [],
};
let input = {
	planRevision: 0,
	graphVersion: 1,
	graphRevision: 1,
	user: "U_test",
	connectionId: "laptop",
	repositoryId: "R_test",
	checkout: { repository: "owner/repository", branch: "main", commit: "a".repeat(40) },
};
async function prepared() {
	let context = await openPlan("# Settled plan\n");
	await implementationGraphs().revise(context.plan, {
		planRevision: 0,
		graphRevision: 0,
		operations: [{ op: "add", task }],
	});
	return context;
}

test("approval closes edit admission before draining an in-flight batch", async () => {
	let { plan, storage } = await prepared();
	let peer = await Room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		Service.source(plan),
		[],
	);
	let candidate = { ...plan, document: peer };
	let changed = Edit.replace(candidate, 0, "# Settled plan\n\nChanged after approval.\n");
	if (!changed.ok || !changed.mutation) throw new Error("No mutation");
	let frames: Array<{ kind: string }> = [];
	let ws = {
		data: { room: plan.id, handle: "test", client: "test", canEdit: true },
		send: (raw: string) => frames.push(JSON.parse(raw)),
		publish() {},
		close() {},
	};
	let submit = (update: Uint8Array, id: string) =>
		Service.submit(plan, ws as never, {
			kind: "plan:update",
			ts: 0,
			rid: id,
			id,
			epoch: plan.document.epoch,
			update: Buffer.from(update).toString("base64"),
		});
	let enter!: () => void;
	let release!: () => void;
	let entered = new Promise<void>(resolve => enter = resolve);
	let blocked = new Promise<void>(resolve => release = resolve);
	let original = storage.collaboration.commit;
	let first = true;
	storage.collaboration.commit = async data => {
		if (first) {
			first = false;
			enter();
			await blocked;
		}
		return original(data);
	};
	try {
		submit(Y.encodeStateAsUpdate(new Y.Doc()), "noop");
		let queued = queueBuild(plan, input);
		await entered;
		submit(changed.mutation.update, "late");
		release();
		await queued;
		await Bun.sleep(20);
		await plan.flushing;
		expect(plan.revision).toBe(0);
		expect(Service.source(plan)).not.toContain("Changed after approval");
		expect(plan.builds[0]?.planRevision).toBe(plan.revision);
	} finally {
		release();
		peer.doc.destroy();
		await Service.close(plan);
	}
});

test("approval prevents a Planner graph edit queued after its review", async () => {
	let { plan, server } = await prepared();
	try {
		let queued = queueBuild(plan, input);
		let edited = plan.flushing.then(() =>
			Promise.resolve().then(() =>
				documentTools.edit_implementation_graph.execute!({
					plan_revision: 0,
					graph_revision: 1,
					operations: [{ op: "replace", id: "first", task: { ...task, title: "Unreviewed" } }],
				} as never, {
					context: { room: { id: plan.id, plan, server }, repository: { id: "R_test" } },
					toolCallId: "review",
					messages: [],
				} as never)
			)
		);
		let [build, result] = await Promise.all([queued, edited]);
		expect(JSON.parse(result as string)).toEqual({ ok: false, reason: "locked" });
		expect(plan.graph?.versions).toHaveLength(1);
		expect(plan.graph?.versions.at(-1)?.number).toBe(build.graphVersion);
	} finally {
		await Service.close(plan);
	}
});
