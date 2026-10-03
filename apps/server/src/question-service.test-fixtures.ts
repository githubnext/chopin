import { afterEach } from "bun:test";
import * as Question from "@chopin/question";

import * as Questions from "./questions/service";
import * as Store from "./questions/store";

import * as Service from "./plan/service";

import { openPlan } from "./testing/plan";
import type { Server } from "bun";
import type { Plan } from "./plan/service";
import type { Socket, SocketData } from "./wire";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
export function createQuestionServiceFixture(
	readPlans: () => Plan[],
	writePlans: (value: Plan[]) => void,
) {
	let plans: Plan[] = [];

	async function opened(source = ""): Promise<Plan> {
		let { plan } = await openPlan(source);
		plans.push(plan);
		return plan;
	}

	async function restart(context: Awaited<ReturnType<typeof openPlan>>): Promise<Plan> {
		await Service.close(context.plan);
		plans.splice(plans.indexOf(context.plan), 1);
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		plans.push(plan);
		return plan;
	}

	function definition(count = 1) {
		return Questions.identify({
			questions: Array.from({ length: count }, (_, index) => ({
				header: `Decision ${index + 1}`,
				question: `What should decision ${index + 1} be?`,
				multiple: false,
				options: [{ label: "Choose this", description: "The selected option." }],
			})),
		});
	}

	function asking(
		plan: Plan,
		server: Server<SocketData>,
		value: ReturnType<typeof definition>,
		placement?: Parameters<typeof Questions.ask>[4],
	) {
		let created = Promise.withResolvers<void>();
		let waiting = Questions.ask(plan, server, "test", value, placement, created.resolve);
		return { created: created.promise, waiting };
	}

	async function answer(plan: Plan): Promise<void> {
		for (let record of [...plan.records.values()].toReversed()) {
			let item = record.definition.questions[0]!;
			let opened = Store.snapshot(plan.questions, record.id);
			if (!opened.open) throw new Error("question was not open");
			let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
				.fork() as unknown as Question.Model;
			model.api.val([item.id, "mode"]).set("choices");
			model.api.val([item.id, "choice"]).set(item.options[0]!.id);
			let patch = model.api.flush();
			if (!patch) throw new Error("answer produced no patch");
			let edited = Store.edit(plan.questions, record.id, [...patch.toBinary()]);
			if (!edited.open || !edited.accepted) throw new Error("could not save answer");
			let claimed = Store.claimSubmit(plan.questions, record.id, edited.revision, item.header);
			if (!claimed.ok) throw new Error("could not settle question");
			Store.commit(plan.questions, claimed.claim);
		}
	}

	async function selectFirstOption(plan: Plan, ws: Socket, id: string): Promise<string> {
		let opened = Store.snapshot(plan.questions, id);
		if (!opened.open) throw new Error("question was not open");
		let question = opened.definition.questions[0]!;
		let optionId = question.options[0]!.id;
		let model = Question.crdt.Model.fromBinary(new Uint8Array(opened.model))
			.fork() as unknown as Question.Model;
		model.api.val([question.id, "choice"]).set(optionId);
		let patch = model.api.flush();
		if (!patch) throw new Error("selection produced no patch");
		await Questions.edit(plan, ws, {
			kind: "question:edit",
			ts: 0,
			rid: "d02-select",
			id,
			patch: [...patch.toBinary()],
		});
		return optionId;
	}

	function member(handle = "ana") {
		let frames: Array<Record<string, unknown>> = [];
		let ws = {
			data: { handle, client: `client-${handle}`, room: "test" },
			send(raw: string) {
				frames.push(JSON.parse(raw));
			},
			publish() {},
		} as unknown as Socket;
		return { ws, frames };
	}
	let cleanup = async () => {
		for (let plan of plans) await Service.close(plan);
		plans = [];
	};
	afterEach(async () => {
		plans = readPlans();
		try {
			await cleanup();
		} finally {
			writePlans(plans);
		}
	});
	return { plans, opened, restart, definition, asking, answer, selectFirstOption, member };
}
