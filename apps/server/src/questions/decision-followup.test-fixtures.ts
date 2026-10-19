import { afterEach, expect } from "bun:test";
import * as Question from "@chopin/question";
import { ulid } from "@chopin/dialect";
import * as Service from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";
import * as Questions from "./service";
import * as Store from "./store";
import { member } from "./text-response.test-fixtures";

let plans: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

export async function fixture(count = 1, marked = true) {
	let context = await openPlan(
		"The approach remains provisional.\n\nKeep this unrelated paragraph.\n",
	);
	plans.push(context.plan);
	let ids: string[] = [];
	let scope = ulid();
	for (let index = 0; index < count; index++) {
		let id = await Questions.capture(context.plan, context.server, context.plan.id, {
			key: `decision-${index}`,
			question: `What matters for approach ${index}?`,
		}, { revision: context.plan.revision });
		if (marked) {
			Object.assign(context.plan.records.get(id)!, {
				followUp: {
					scope,
					target: [
						Room.anchorAt(context.plan.document, 0, Room.digests(context.plan.document)[0]!),
					],
				},
			});
		}
		ids.push(id);
	}
	async function save(id: string, text: string) {
		let actor = member();
		let entry = Store.get(context.plan.questions, id)!;
		let question = entry.definition.questions[0]!;
		let fork = entry.model.fork() as Question.Model;
		fork.api.str([question.id, "custom"]).ins(0, text);
		await Questions.edit(context.plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(context.plan, context.server, context.plan.id, actor.ws, {
			kind: "question:submit",
			ts: 0,
			rid: "save",
			id,
			revision: Store.get(context.plan.questions, id)!.revision,
		});
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	}
	return { ...context, ids, save };
}

export function scopeRoom(context: Awaited<ReturnType<typeof fixture>>) {
	return {
		id: context.plan.id,
		plan: context.plan,
		server: context.server,
		exclusive: <T>(action: () => Promise<T>) => Service.exclusive(context.plan, action),
		anchors() {},
		changes() {},
		visualAdmission: async () => [],
	} as unknown as import("../agent/tools").DocumentRoom;
}

export function running(context: Awaited<ReturnType<typeof fixture>>, id = context.ids[0]!) {
	let job = {
		id: `decision-followup:${id}:decided:${id}:1`,
		kind: "decision-followup",
		target: id,
		trigger: `decided:${id}:1`,
		status: "running",
		attempts: 0,
		at: context.now.toISOString(),
	} as const;
	context.plan.chat.job = job;
	return job;
}

export async function restart(context: Awaited<ReturnType<typeof fixture>>) {
	await Service.close(context.plan);
	plans = plans.filter(plan => plan !== context.plan);
	let plan = await Service.open(context.channel.id, context.backend, context.server);
	plans.push(plan);
	return { ...context, plan };
}
