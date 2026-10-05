import { afterEach } from "bun:test";
import { toolbox } from "./scoped-tools.test-bridge";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";

export function createReviseOpenDecisionFixture(
	readContexts: () => Awaited<ReturnType<typeof openPlan>>[],
	writeContexts: (value: Awaited<ReturnType<typeof openPlan>>[]) => void,
) {
	let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];

	async function opened(options: Array<{ id: string; label: string }> = []) {
		let context = await openPlan("Opening prose.\n");
		contexts.push(context);
		let id = await Questions.insertConversationCard(context.plan, context.server, "test", {
			threadId: "thread-a",
			header: "Authentication",
			question: "What auth system should we use?",
			options,
		});
		context.plan.chat.busy = true;
		context.plan.chat.turn = {
			id: "turn-1",
			handle: "ana",
			started: 1,
			entryOffset: 0,
			responded: false,
		};
		let request: { text: string } | undefined = {
			text:
				"@chopin revise the question for the Authentication decision and add an option to the Authentication decision",
		};
		let tools = toolbox({
			plan: context.plan,
			server: context.server,
			room: "test",
			persist: () => Service.persist(context.plan),
			exclusive: action => Service.exclusive(context.plan, action),
			async publish() {},
			anchors() {},
			changes() {},
			currentMemberRequest: () => request,
		});
		let found = tools.find(item => item.name === "revise_open_decision");
		if (!found?.handler) throw new Error("revise_open_decision is missing");
		let call = (input: unknown) => Promise.resolve(found.handler!(input, {} as never)).then(String);
		return { ...context, id, tools, call, request: (value?: { text: string }) => request = value };
	}

	let cleanup = async () => {
		for (let context of contexts) await Service.close(context.plan);
		contexts = [];
	};
	afterEach(async () => {
		contexts = readContexts();
		try {
			await cleanup();
		} finally {
			writeContexts(contexts);
		}
	});
	return { contexts, opened };
}
