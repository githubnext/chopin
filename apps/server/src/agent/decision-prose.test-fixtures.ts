import { afterEach } from "bun:test";
import { toolbox } from "./scoped-tools.test-bridge";
import * as Service from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";

export type Opened = Awaited<ReturnType<typeof openPlan>>;

export function createDecisionProseFixture(
	readContexts: () => Awaited<ReturnType<typeof openPlan>>[],
	writeContexts: (value: Awaited<ReturnType<typeof openPlan>>[]) => void,
) {
	const CARD = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

	const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";

	const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

	const WIDGET = `<Questionnaire id="${CARD}" status="decided" thread="t1">
<Question id="${QUESTION}" header="Auth" prompt="Which authentication approach?" multiple="false">
<Option id="${OPTION}" label="GitHub Apps" />
<Answer value="GitHub Apps" choices="${OPTION}" />
</Question>
</Questionnaire>
`;

	const OTHER_WIDGET = WIDGET
		.replaceAll(CARD, "01K0N4X2M5R8T3VQ7YB6ZC4DEF")
		.replaceAll(QUESTION, "01K0N4Y2M5R8T3VQ7YB6ZC4DEF")
		.replaceAll(OPTION, "01K0N4Z2M5R8T3VQ7YB6ZC4DEF");

	let contexts: Opened[] = [];

	async function opened(source = `Context.\n\n${WIDGET}`) {
		let context = await openPlan(source);
		contexts.push(context);
		context.plan.records.set(
			CARD,
			Questions.normalizeRecord({
				id: CARD,
				definition: {
					questions: [{
						id: QUESTION,
						header: "Auth",
						question: "Which authentication approach?",
						multiple: false,
						options: [{ id: OPTION, label: "GitHub Apps", description: "" }],
					}],
				},
				status: "answered",
				origin: "conversation",
				threadId: "t1",
				owner: "mina",
				decidedAt: 1_758_645_000,
				choices: [OPTION],
			}),
		);
		return context;
	}

	function job(context: Opened, generation = 1) {
		context.plan.chat.job = {
			id: `prose:${CARD}:decided:${CARD}:${generation}`,
			kind: "prose",
			target: CARD,
			trigger: `decided:${CARD}:${generation}`,
			status: "running",
			attempts: 0,
			at: "2026-09-25T10:00:00.000Z",
		};
	}

	function proseTool(context: Opened, exclusive = Service.exclusive) {
		let anchors = 0;
		let changes = 0;
		let found = toolbox({
			plan: context.plan,
			server: context.server,
			room: "test",
			persist: () => Service.persist(context.plan),
			exclusive: action => exclusive(context.plan, action),
			async publish() {},
			anchors() {
				anchors++;
				Service.anchors(context.plan, context.server, "test");
			},
			changes() {
				changes++;
			},
		}).find(item => item.name === "write_decision_prose");
		if (!found?.handler) throw new Error("write_decision_prose is missing");
		return { handler: found.handler, anchors: () => anchors, changes: () => changes };
	}

	function input(context: Opened, text = "We chose GitHub Apps.") {
		return { revision: context.plan.revision, id: CARD, text };
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
	return { CARD, QUESTION, OPTION, WIDGET, OTHER_WIDGET, contexts, opened, job, proseTool, input };
}
