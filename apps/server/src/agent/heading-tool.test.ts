import { afterEach, expect, spyOn, test } from "bun:test";
import { QuestionnaireNode } from "@chopin/dialect";
import { $nodesOfType } from "lexical";

import { toolbox } from "./heading-tool.test-bridge";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { ConversationPlan } from "@chopin/protocol";

const CARD = `<Questionnaire id="01K0N4X2M5R8T3VQ7YB6ZC4DEF" by="ana" at="2026-07-28T10:14:00.000Z">
<Question id="01K0N4Y2M5R8T3VQ7YB6ZC4DEF" header="Scope" prompt="What ships first?" multiple="false">
<Option id="01K0N4Z2M5R8T3VQ7YB6ZC4DEF" label="Anchors" />
</Question>
</Questionnaire>
`;

let contexts: Awaited<ReturnType<typeof openPlan>>[] = [];

afterEach(async () => {
	for (let context of contexts) await Service.close(context.plan);
	contexts = [];
});

async function opened(source: string) {
	let context = await openPlan(source);
	contexts.push(context);
	return context;
}

function headingJob(plan: Awaited<ReturnType<typeof Service.open>>) {
	plan.chat.job = {
		id: "heading:document:m0",
		kind: "heading",
		target: "document",
		trigger: "m0",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

function headingTool(context: Awaited<ReturnType<typeof openPlan>>, exclusive = Service.exclusive) {
	let found = toolbox({
		plan: context.plan,
		server: context.server,
		room: "test",
		persist: () => Service.persist(context.plan),
		exclusive: action => exclusive(context.plan, action),
		async publish() {},
		anchors() {},
		changes() {},
	}).find(item => item.name === "draft_heading");
	if (!found?.handler) throw new Error("draft_heading is missing");
	return { handler: found.handler };
}

function cardKey(context: Awaited<ReturnType<typeof openPlan>>): string {
	let key = "";
	context.plan.document.editor.getEditorState().read(() => {
		key = $nodesOfType(QuestionnaireNode)[0]?.getKey() ?? "";
	});
	return key;
}

const INPUT = {
	revision: 0,
	title: "Authentication Strategy",
	goal: "Goal: Decide how people sign in.",
};

test("draft_heading titles an empty document in one durable update", async () => {
	let context = await opened("");
	headingJob(context.plan);
	let result = await headingTool(context).handler(INPUT, {} as never);
	expect(JSON.parse(String(result))).toEqual({
		ok: true,
		revision: 1,
		title: INPUT.title,
		goal: INPUT.goal,
	});
	expect(room.project(context.plan.document)).toBe(`# ${INPUT.title}\n\n${INPUT.goal}\n`);
	expect(context.plan.document.seq).toBe(1);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
});

test("draft_heading commits one heading and paragraph before the existing card", async () => {
	let context = await opened(CARD);
	headingJob(context.plan);
	let before = room.project(context.plan.document);
	let key = cardKey(context);
	let threads = context.plan.threads;
	let result = await headingTool(context).handler(INPUT, {} as never);
	expect(JSON.parse(String(result))).toEqual({
		ok: true,
		revision: 1,
		title: INPUT.title,
		goal: INPUT.goal,
	});
	let expected = `# ${INPUT.title}\n\n${INPUT.goal}\n\n${before}`;
	expect(room.project(context.plan.document)).toBe(expected);
	expect(cardKey(context)).toBe(key);
	expect(context.plan.threads).not.toBe(threads);
	expect(context.plan.document.seq).toBe(1);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(1);
	expect(JSON.parse(context.plan.chat.jobOutput!)).toEqual({
		title: INPUT.title,
		goal: INPUT.goal,
	});
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(loaded)).source).toBe(expected);
});

test("draft_heading replaces only the empty H1 template before cards", async () => {
	let context = await opened(`# \n\n${CARD}`);
	headingJob(context.plan);
	let before = room.project(context.plan.document);
	expect(before.startsWith("#\n\n")).toBe(true);
	let key = cardKey(context);
	let result = await headingTool(context).handler(INPUT, {} as never);
	expect(JSON.parse(String(result)).ok).toBe(true);
	expect(room.project(context.plan.document)).toBe(
		`# ${INPUT.title}\n\n${INPUT.goal}\n\n${before.slice("#\n\n".length)}`,
	);
	expect(cardKey(context)).toBe(key);
});

test("draft_heading refuses human prose and leaves the document untouched", async () => {
	for (let source of ["Somebody wrote this.\n", "# Human heading\n\nA human goal.\n"]) {
		let context = await opened(source);
		headingJob(context.plan);
		let before = room.project(context.plan.document);
		let result = await headingTool(context).handler(INPUT, {} as never);
		expect(String(result)).toBe(
			"Error: The document already has prose. A background job only titles an empty document.",
		);
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.document.seq).toBe(0);
		expect(context.plan.chat.jobOutput).toBeUndefined();
	}
});

test("draft_heading rejects missing, wrong, stale, and replaced job scope", async () => {
	let context = await opened("");
	let missing = await headingTool(context).handler(INPUT, {} as never);
	expect(String(missing)).toContain("only available to a background Planner job");
	headingJob(context.plan);
	context.plan.chat.job = { ...context.plan.chat.job!, target: "other" } as ConversationPlan.Job;
	expect(String(await headingTool(context).handler(INPUT, {} as never))).toContain(
		"heading job target is not the document",
	);
	headingJob(context.plan);
	expect(String(await headingTool(context).handler({ ...INPUT, revision: 99 }, {} as never)))
		.toContain("stale; read_plan again");
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let delayed = headingTool(context, (_plan, action) => {
		entered.resolve();
		return release.promise.then(action);
	});
	let result = delayed.handler(INPUT, {} as never);
	await entered.promise;
	context.plan.chat.job = { ...context.plan.chat.job!, id: "heading:document:m1" };
	release.resolve();
	expect(String(await result)).toContain("background Planner job changed");
	expect(room.project(context.plan.document)).toBe("");
	expect(context.plan.chat.jobOutput).toBeUndefined();
});

test("draft_heading rejects lengths, CR titles, blank lines, and non-paragraph goals", async () => {
	let context = await opened("");
	headingJob(context.plan);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let input of [
				{ ...INPUT, title: "x".repeat(81) },
				{ ...INPUT, title: "First\rSecond" },
				{ ...INPUT, title: "# Already a heading" },
				{ ...INPUT, extra: "surprise" },
				{ ...INPUT, goal: "x".repeat(401) },
				{ ...INPUT, goal: "First\r\n\r\nSecond" },
				{ ...INPUT, goal: "- a list item" },
				{ ...INPUT, goal: "```ts\ncode\n```" },
				{ ...INPUT, goal: "<Unknown />" },
			]
		) {
			expect(String(await headingTool(context).handler(input, {} as never))).toStartWith("Error:");
			expect(room.project(context.plan.document)).toBe("");
		}
	} finally {
		errors.mockRestore();
	}
	expect(context.plan.chat.jobOutput).toBeUndefined();
});

test("failed heading persistence leaves no live edit, publication, or job output", async () => {
	let context = await opened(CARD);
	headingJob(context.plan);
	let before = room.project(context.plan.document);
	let outlines = new Map(context.plan.outlines);
	let threads = context.plan.threads;
	let original = context.storage.collaboration.commit;
	context.storage.collaboration.commit = async () => {
		throw new Error("storage unavailable");
	};
	context.backend.fatal = () => {};
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(String(await headingTool(context).handler(INPUT, {} as never)))
			.toBe("Error: storage unavailable");
	} finally {
		errors.mockRestore();
		context.storage.collaboration.commit = original;
	}
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.plan.revision).toBe(0);
	expect(context.plan.document.seq).toBe(0);
	expect(context.plan.outlines).toEqual(outlines);
	expect(context.plan.threads).toBe(threads);
	expect(context.plan.chat.jobOutput).toBeUndefined();
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(0);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(loaded)).source).toBe(before);
});
