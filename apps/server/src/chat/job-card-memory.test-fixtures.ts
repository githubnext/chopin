import { expect } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import { createPlannerJobs } from "../conversation-plan/planner-jobs";
import { PROMPT_FOR } from "../conversation-plan/job-prompts";
import { JOB_TOOLS } from "../agent/job-scope";
import { documentTools } from "../agent/tools";
import { scopedJobTools } from "../agent/job-tools";

export const CARD = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
export const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
export const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const WIDGET = `<Questionnaire id="${CARD}" status="decided" thread="t1">
<Question id="${QUESTION}" header="Auth" prompt="Which authentication approach?" multiple="false">
<Option id="${OPTION}" label="GitHub Apps" />
<Answer value="GitHub Apps" choices="${OPTION}" />
</Question>
</Questionnaire>
`;

export async function cardMemory(kind: "refine" | "suggest" | "prose") {
	let answered = Questions.normalizeRecord({
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
	});
	let opened = kind === "prose"
		? await openPlan(`Context.\n\n${WIDGET}`, { questions: [answered] })
		: await openPlan("Opening prose.\n\nLater prose.\n");
	let plan = opened.plan;
	let id = kind === "prose"
		? CARD
		: await Questions.insertConversationCard(plan, opened.server, opened.channel.id, {
			threadId: "thread-a",
			header: "Authentication",
			question: "What auth system should we use?",
			options: [],
		});
	plan.chat.entries.push({
		id: "m1",
		author: { kind: "member", handle: "ana" },
		text: "We need to choose authentication.",
		ts: 1,
	});
	await Plan.persist(plan);
	let raw = kind === "prose"
		? { revision: plan.revision, id, text: "We chose GitHub Apps." }
		: kind === "refine"
		? { revision: plan.revision, id, title: "How should people sign in?", add_options: [] }
		: {
			revision: plan.revision,
			id,
			add_options: [{ label: "Passkeys", rationale: "Avoids passwords for account access." }],
		};
	let identity = await authenticatedMemory(opened, kind, { name: JOB_TOOLS[kind], input: raw });
	let errors: unknown[] = [];
	identity.onStart(async () => {
		let before = Plan.source(plan);
		let guarded = scopedJobTools(documentTools, Chat.documentRoom(identity.context));
		let result = await guarded.edit_plan!.execute!(
			{
				revision: plan.revision,
				operations: [{ op: "insert_root", source: "Unauthorized paragraph." }],
			},
			{
				toolCallId: "foreign",
				messages: [],
				context: { room: Chat.documentRoom(identity.context) },
			} as never,
		);
		expect(String(result)).toContain(`use only ${JOB_TOOLS[kind]}`);
		expect(Plan.source(plan)).toBe(before);
	});
	identity.onResult(async output => {
		expect(String(output)).toContain('"ok": true');
		identity.driver.finish();
	});
	let jobs = createPlannerJobs({
		plan,
		exclusive: action => Plan.exclusive(plan, action),
		persist: () => Plan.persistExclusive(plan),
		runner: (job, prompt, signal) =>
			Chat.job(identity.context, job, prompt, identity.sessionId, signal),
		prompt: job => PROMPT_FOR[job.kind]?.(plan, job),
		publishJobs: current =>
			opened.server.publish(
				opened.channel.id,
				JSON.stringify({ kind: "conversation-plan:jobs", jobs: current }),
			),
		publishMeta: target => Questions.announce(plan, opened.server, opened.channel.id, target),
		activity: async text => {
			await Chat.noticeExclusive(identity.context, text);
		},
		onError: error => errors.push(error),
	});
	let trigger = kind === "prose" ? `decided:${CARD}:1` : "m1";
	return {
		...identity,
		opened,
		plan,
		jobs,
		id,
		errors,
		async run() {
			await jobs.enqueue({ kind, target: id, trigger });
			await jobs.idle();
		},
		async close() {
			jobs.stop();
			identity.revokeAll();
			await jobs.idle();
			await Plan.close(plan);
		},
	};
}
