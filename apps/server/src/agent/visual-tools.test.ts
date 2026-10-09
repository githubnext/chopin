import { afterEach, expect, test } from "bun:test";

import { visualExample } from "./visual-catalog";
import { type DocumentRoom, documentTools } from "./tools";
import { PLANNER_TOOL_NAMES } from "../harness/tool-names";
import * as Edit from "../plan/edit";
import * as Service from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";

import type { JevResult } from "../conversation-plan/jev";

let plans: Awaited<ReturnType<typeof Service.open>>[] = [];

afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

function result(answers: JevResult["answers"]): JevResult {
	return {
		model: "jev-test",
		answers,
		usage: { input_tokens: 10, output_tokens: 2 },
		latencyMs: 1,
	};
}

async function fixture() {
	let opened = await openPlan("# Visual test\n\nInitial paragraph.\n");
	plans.push(opened.plan);
	let locked = false;
	let calls = 0;
	let member = {
		entryId: "member-1",
		userId: "user-1",
		handle: "writer",
		text: "When does the async body run?",
		claimantSessionId: undefined,
		turnId: "turn-1",
		lifecycle: 1,
	};
	let controller = new AbortController();
	let room: DocumentRoom = {
		id: opened.channel.id,
		plan: opened.plan,
		server: opened.server,
		publish: mutation => Service.publish(opened.plan, opened.server, opened.channel.id, mutation),
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
		currentMemberRequest: () => controller.signal.aborted ? undefined : member,
		visual: {
			ask: async request => {
				expect(locked).toBe(false);
				calls++;
				let key = Object.keys(request.questions)[0];
				if (key === "p0") return result({ p0: { type: "noul", noul: 0.9 } });
				if (key === "h0") return result({ h0: { type: "noul", noul: 0.8 } });
				return result({
					t0: { type: "choice", choice: "flowchart", confidence: 0.7, probabilities: {} },
				});
			},
		},
	};
	let call = async (name: "assess_visual" | "edit_plan", input: unknown) => {
		let output = await documentTools[name].execute!(input as never, {
			context: { room },
			toolCallId: name,
			messages: [],
		} as never);
		if (typeof output !== "string") throw new Error("tool did not return text");
		return output.startsWith("Error:") ? output : JSON.parse(output);
	};
	return {
		room,
		call,
		controller,
		get calls() {
			return calls;
		},
	};
}

test("one foreground visual route gates edit_plan and Jev never runs under the document lock", async () => {
	let setup = await fixture();
	let { room, call } = setup;
	let revision = room.plan.revision;
	let passage = "Calling an async function returns a future. Polling advances its body.";
	let operation = { op: "insert_root", source: passage };
	let proposed = { revision, operations: [operation] };
	expect(await call("edit_plan", proposed)).toMatchObject({ ok: false, reason: "missing-route" });
	expect(Room.project(room.plan.document)).not.toContain(passage);

	let assessed = await call("assess_visual", { revision, operation });
	expect(assessed).toMatchObject({
		ok: true,
		route: { kind: "diagram", type: "flowchart", possibility: 0.9, helpfulness: 0.8 },
	});
	expect(assessed.example).toEqual(visualExample("flowchart"));
	expect(setup.calls).toBe(3);
	let visual_route = assessed.visual_route;
	expect(await call("edit_plan", { ...proposed, visual_route })).toMatchObject({
		ok: false,
		reason: "missing-selected-visual",
	});
	let fence = `\`\`\`seecode\n${JSON.stringify(visualExample("flowchart"))}\n\`\`\``;
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "insert_root", source: `Different explanation.\n\n${fence}` }],
			visual_route,
		}),
	).toMatchObject({ ok: false, reason: "changed-passage" });
	expect(
		await call("edit_plan", {
			revision: revision + 1,
			operations: [{ op: "insert_root", source: `${passage}\n\n${fence}` }],
			visual_route,
		}),
	).toMatchObject({ ok: false, reason: "stale-route" });
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "replace", index: 1, source: `${passage}\n\n${fence}` }],
			visual_route,
		}),
	).toMatchObject({ ok: false, reason: "wrong-placement" });
	let other = `\`\`\`seecode\n${JSON.stringify(visualExample("dependency"))}\n\`\`\``;
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "insert_root", source: `${passage}\n\n${other}` }],
			visual_route,
		}),
	).toMatchObject({ ok: false, reason: "wrong-type" });
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "insert_root", source: `${passage}\n\n${fence}` }],
			visual_route,
		}),
	).toMatchObject({ ok: true });
	expect(Room.project(room.plan.document)).toContain("```seecode");
	expect(room.visual?.pending).toBeUndefined();
});

test("a rejected diagram names its invalid field and can be repaired on the same route", async () => {
	let setup = await fixture();
	let { room, call } = setup;
	let revision = room.plan.revision;
	let passage = "Polling starts the future's body.";
	let assessed = await call("assess_visual", {
		revision,
		operation: { op: "insert_root", source: passage },
	});
	let diagram = {
		type: "flowchart",
		nodes: [{
			id: "future",
			label: "Anonymous Future returned; body has not run",
			row: 0,
			col: 0,
		}],
	};
	let write = () =>
		call("edit_plan", {
			revision,
			visual_route: assessed.visual_route,
			operations: [{
				op: "insert_root",
				source: `${passage}\n\n\`\`\`seecode\n${JSON.stringify(diagram)}\n\`\`\``,
			}],
		});
	expect(await write()).toMatchObject({
		ok: false,
		reason: "invalid-visual",
		problems: [{
			code: "E_SPEC",
			at: "nodes[0].label",
			msg: "too long (max 40 chars)",
		}],
	});
	expect(Room.project(room.plan.document)).not.toContain(passage);
	diagram.nodes[0]!.label = "Future returned; body has not run";
	expect(await write()).toMatchObject({ ok: true });
	expect(Room.project(room.plan.document)).toContain("```seecode");
	expect(setup.calls).toBe(3);
});

test("a foreground visual session allows headings but refuses unsupported prose shapes", async () => {
	let { room, call } = await fixture();
	let revision = room.plan.revision;
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "insert_root", source: "## Token check" }],
		}),
	).toMatchObject({ ok: true });
	expect(
		await call("edit_plan", {
			revision: room.plan.revision,
			operations: [{ op: "insert_root", source: "- First\n- Second" }],
		}),
	).toContain("visual routing supports only headings or one explanatory paragraph");
	expect(Room.project(room.plan.document)).not.toContain("First");
});

test("a human edit after assessment makes the route stale before publication", async () => {
	let { room, call } = await fixture();
	let revision = room.plan.revision;
	let passage = "The request crosses two services in sequence.";
	let operation = { op: "insert_root", source: passage };
	let assessed = await call("assess_visual", { revision, operation });
	await Service.exclusive(room.plan, async () => {
		let changed = Edit.apply(room.plan, revision, [{ op: "insert_root", source: "Human note." }]);
		expect(changed.ok).toBe(true);
		if (changed.ok && changed.mutation) {
			await Service.publish(room.plan, room.server, room.id, changed.mutation);
		}
	});
	let fence = `\`\`\`seecode\n${JSON.stringify(visualExample("flowchart"))}\n\`\`\``;
	expect(
		await call("edit_plan", {
			revision,
			operations: [{ op: "insert_root", source: `${passage}\n\n${fence}` }],
			visual_route: assessed.visual_route,
		}),
	).toMatchObject({ ok: false, reason: "stale-route" });
	expect(Room.project(room.plan.document)).not.toContain(passage);
});

test("a human edit while Jev is pending discards the answer before another provider call", async () => {
	let { room, call } = await fixture();
	let revision = room.plan.revision;
	let entered = Promise.withResolvers<void>();
	let pending = Promise.withResolvers<JevResult>();
	let providerCalls = 0;
	room.visual!.ask = async () => {
		providerCalls++;
		entered.resolve();
		return pending.promise;
	};
	let assessing = call("assess_visual", {
		revision,
		operation: { op: "insert_root", source: "A request crosses two services." },
	});
	await entered.promise;
	await Service.exclusive(room.plan, async () => {
		let changed = Edit.apply(room.plan, revision, [{ op: "insert_root", source: "Human note." }]);
		expect(changed.ok).toBe(true);
		if (changed.ok && changed.mutation) {
			await Service.publish(room.plan, room.server, room.id, changed.mutation);
		}
	});
	pending.resolve(result({ p0: { type: "noul", noul: 0.9 } }));
	expect(await assessing).toMatchObject({ ok: false, reason: "stale-route" });
	expect(providerCalls).toBe(1);
	expect(room.visual?.pending).toBeUndefined();
});

test("Stop during assessment and before commit prevents the route from being used", async () => {
	let first = await fixture();
	let revision = first.room.plan.revision;
	let passage = "A request crosses two services.";
	let entered = Promise.withResolvers<void>();
	let pending = Promise.withResolvers<JevResult>();
	let providerCalls = 0;
	first.room.visual!.ask = async () => {
		providerCalls++;
		entered.resolve();
		return pending.promise;
	};
	let assessing = first.call("assess_visual", {
		revision,
		operation: { op: "insert_root", source: passage },
	});
	await entered.promise;
	first.controller.abort();
	pending.resolve(result({ p0: { type: "noul", noul: 0.9 } }));
	expect(await assessing).toMatchObject({ ok: false, reason: "stale-route" });
	expect(providerCalls).toBe(1);
	expect(first.room.visual?.pending).toBeUndefined();

	let second = await fixture();
	let route = await second.call("assess_visual", {
		revision: second.room.plan.revision,
		operation: { op: "insert_root", source: passage },
	});
	second.controller.abort();
	let fence = `\`\`\`seecode\n${JSON.stringify(visualExample("flowchart"))}\n\`\`\``;
	expect(
		await second.call("edit_plan", {
			revision: second.room.plan.revision,
			operations: [{ op: "insert_root", source: `${passage}\n\n${fence}` }],
			visual_route: route.visual_route,
		}),
	).toMatchObject({ ok: false, reason: "missing-route" });
	expect(Room.project(second.room.plan.document)).not.toContain(passage);
});

test("a Jev no and an unavailable assessment stay distinct in the foreground tool", async () => {
	let { room, call } = await fixture();
	let revision = room.plan.revision;
	let operation = { op: "insert_root", source: "A single unsupported claim." };
	room.visual!.ask = async () => result({ p0: { type: "noul", noul: 0.1 } });
	let no = await call("assess_visual", { revision, operation });
	expect(no.ok).toBe(true);
	expect(no.route).toMatchObject({ kind: "prose", reason: "not-visualizable" });
	expect(no.failure).toBeUndefined();
	room.visual!.ask = async () => {
		throw new Error("Jev request timed out");
	};
	let unavailable = await call("assess_visual", { revision, operation });
	expect(unavailable).toMatchObject({
		ok: false,
		reason: "assessment-unavailable",
		failure: { stage: "possibility", reason: "timeout" },
	});
	expect(unavailable.visual_route).toBeUndefined();
	expect(room.visual?.pending?.id).toBe(no.visual_route);
	expect(
		await call("edit_plan", {
			revision,
			visual_route: no.visual_route,
			operations: [operation],
		}),
	).toMatchObject({ ok: true });

	let initial = await fixture();
	initial.room.visual!.ask = async () => {
		throw new Error("Jev request timed out");
	};
	let failed = await initial.call("assess_visual", {
		revision: initial.room.plan.revision,
		operation,
	});
	expect(failed).toMatchObject({ ok: false, reason: "assessment-unavailable" });
	expect(failed.visual_route).toBeUndefined();
	expect(initial.room.visual?.pending).toBeUndefined();
	expect(
		await initial.call("edit_plan", {
			revision: initial.room.plan.revision,
			operations: [operation],
		}),
	).toMatchObject({ ok: false, reason: "missing-route" });
	expect(Room.project(initial.room.plan.document)).not.toContain(operation.source);
});

test("a failed reassessment cannot turn a selected diagram into prose", async () => {
	let { room, call } = await fixture();
	let revision = room.plan.revision;
	let passage = "Polling starts the future's body.";
	let original = { op: "insert_root", source: passage };
	let selected = await call("assess_visual", { revision, operation: original });
	let diagram = {
		type: "flowchart",
		nodes: [{
			id: "future",
			label: "Anonymous Future returned; body has not run",
			row: 0,
			col: 0,
		}],
	};
	let diagramEdit = () =>
		call("edit_plan", {
			revision,
			visual_route: selected.visual_route,
			operations: [{
				op: "insert_root",
				source: `${passage}\n\n\`\`\`seecode\n${JSON.stringify(diagram)}\n\`\`\``,
			}],
		});
	expect(await diagramEdit()).toMatchObject({ ok: false, reason: "invalid-visual" });
	room.visual!.ask = async () => {
		throw new Error("Jev request timed out");
	};
	let revised = { op: "insert_root", source: "Polling begins the function body." };
	let failed = await call("assess_visual", { revision, operation: revised });
	expect(failed).toMatchObject({ ok: false, reason: "assessment-unavailable" });
	expect(failed.visual_route).toBeUndefined();
	expect(room.visual?.pending?.id).toBe(selected.visual_route);
	expect(
		await call("edit_plan", {
			revision,
			operations: [revised],
		}),
	).toMatchObject({ ok: false, reason: "missing-route" });
	expect(
		await call("edit_plan", {
			revision,
			visual_route: selected.visual_route,
			operations: [revised],
		}),
	).toMatchObject({ ok: false, reason: "changed-passage" });
	expect(
		await call("edit_plan", {
			revision,
			visual_route: selected.visual_route,
			operations: [original],
		}),
	).toMatchObject({ ok: false, reason: "missing-selected-visual" });
	diagram.nodes[0]!.label = "Future returned; body has not run";
	expect(await diagramEdit()).toMatchObject({ ok: true });
});

test("the experimental tool is not active in the default production Planner", () => {
	expect(PLANNER_TOOL_NAMES).not.toContain("assess_visual");
});
