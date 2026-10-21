import { afterEach, expect, spyOn, test } from "bun:test";
import { QuestionnaireNode } from "@chopin/dialect";
import { $createTextNode, $getRoot, $isElementNode, $nodesOfType } from "lexical";
import * as Y from "yjs";

import { toolbox } from "./heading-tool.test-bridge";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

import type { ConversationPlan } from "@chopin/protocol";
import type { Socket } from "../wire";

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

test("draft_heading keeps a member's title and still seeds the goal of an empty body", async () => {
	let member = "E2E5 2026-10-16: verify login resume";
	let context = await opened(`# ${member}\n\n${CARD}`);
	headingJob(context.plan);
	let before = room.project(context.plan.document);
	let result = await headingTool(context).handler(
		{ revision: 0, title: "Verify login logic in auth.rs", goal: INPUT.goal },
		{} as never,
	);
	expect(JSON.parse(String(result))).toMatchObject({ ok: true, title: member, goal: INPUT.goal });
	expect(room.project(context.plan.document)).toBe(
		before.replace(`# ${member}\n\n`, `# ${member}\n\n${INPUT.goal}\n\n`),
	);
});

test("draft_heading keeps a member's title over a body it does not change", async () => {
	let context = await opened(
		`# Human title\n\nGoal: Keep our goal.\n\nBody prose.\n\n# Body heading\n\n${CARD}`,
	);
	headingJob(context.plan);
	let before = room.project(context.plan.document);
	let result = await headingTool(context).handler(INPUT, {} as never);
	expect(JSON.parse(String(result))).toMatchObject({ ok: true, changed: false, revision: 0 });
	expect(room.project(context.plan.document)).toBe(before);
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(0);
});

test("draft_heading titles a document still carrying its generated name", async () => {
	let context = await opened("# amber-river\n\nExisting body.\n");
	headingJob(context.plan);
	let result = await headingTool(context).handler({ revision: 0, title: INPUT.title }, {} as never);
	expect(JSON.parse(String(result))).toMatchObject({ ok: true, title: INPUT.title });
	expect(room.project(context.plan.document)).toBe(`# ${INPUT.title}\n\nExisting body.\n`);
});

test("a later draft refines a Planner title, also after the document reopens", async () => {
	let context = await opened("# \n\nExisting body.\n");
	headingJob(context.plan);
	await headingTool(context).handler({ revision: 0, title: "First draft" }, {} as never);
	expect(room.project(context.plan.document)).toBe("# First draft\n\nExisting body.\n");
	await Service.close(context.plan);
	context.plan = await Service.open(context.channel.id, context.backend, context.server);
	headingJob(context.plan);
	let result = await headingTool(context).handler(
		{ revision: context.plan.revision, title: "Second draft" },
		{} as never,
	);
	expect(JSON.parse(String(result))).toMatchObject({ ok: true, title: "Second draft" });
	expect(room.project(context.plan.document)).toBe("# Second draft\n\nExisting body.\n");
});

test("a member's rename after a draft is kept by the next draft", async () => {
	let context = await opened("# \n\nExisting body.\n");
	headingJob(context.plan);
	await headingTool(context).handler({ revision: 0, title: "First draft" }, {} as never);
	await Service.exclusive(context.plan, () => Service.rename(context.plan, "Member title"));
	headingJob(context.plan);
	let result = await headingTool(context).handler(
		{ revision: context.plan.revision, title: "Second draft" },
		{} as never,
	);
	expect(JSON.parse(String(result))).toMatchObject({ ok: true, changed: false });
	expect(room.project(context.plan.document)).toBe("# Member title\n\nExisting body.\n");
});

test("a person's rename is never redrafted, even to a blank, generated or earlier draft", async () => {
	for (let renamed of ["", "quiet-river", "First draft"]) {
		let context = await opened("# \n\nExisting body.\n");
		headingJob(context.plan);
		await headingTool(context).handler({ revision: 0, title: "First draft" }, {} as never);
		await Service.exclusive(context.plan, () => Service.rename(context.plan, "Member title"));
		await Service.exclusive(context.plan, () => Service.rename(context.plan, renamed));
		let kept = room.project(context.plan.document);
		await Service.close(context.plan);
		context.plan = await Service.open(context.channel.id, context.backend, context.server);
		headingJob(context.plan);
		let result = await headingTool(context).handler(
			{ revision: context.plan.revision, title: "Second draft" },
			{} as never,
		);
		expect(JSON.parse(String(result))).toMatchObject({ ok: true, changed: false });
		expect(room.project(context.plan.document)).toBe(kept);
	}
});

test("a draft waits while a person has the title open, and for a while after", async () => {
	let context = await opened("# amber-river\n\nExisting body.\n");
	let person = {};
	let clock = spyOn(Date, "now");
	let at = Date.parse("2026-10-21T10:00:00.000Z");
	clock.mockImplementation(() => at);
	try {
		Service.titling(context.plan, person, { active: true });
		headingJob(context.plan);
		let held = await headingTool(context).handler({ revision: 0, title: "Drafted" }, {} as never);
		expect(JSON.parse(String(held))).toMatchObject({ ok: true, changed: false });
		Service.titling(context.plan, person, { active: false });
		at += 30_000;
		headingJob(context.plan);
		await headingTool(context).handler({ revision: 0, title: "Drafted" }, {} as never);
		expect(room.project(context.plan.document)).toBe("# amber-river\n\nExisting body.\n");
		at += 31_000;
		headingJob(context.plan);
		let applied = await headingTool(context).handler(
			{ revision: 0, title: "Drafted" },
			{} as never,
		);
		expect(JSON.parse(String(applied))).toMatchObject({ ok: true, title: "Drafted" });
		expect(room.project(context.plan.document)).toBe("# Drafted\n\nExisting body.\n");
	} finally {
		clock.mockRestore();
	}
});

test("a person who typed in the title field holds drafts until they leave", async () => {
	let context = await opened("# amber-river\n\nExisting body.\n");
	let person = {};
	let clock = spyOn(Date, "now");
	let at = Date.parse("2026-10-21T10:00:00.000Z");
	clock.mockImplementation(() => at);
	try {
		Service.titling(context.plan, person, { active: true, edited: true });
		Service.titling(context.plan, person, { active: false });
		at += 10 * 60_000;
		headingJob(context.plan);
		await headingTool(context).handler({ revision: 0, title: "Drafted" }, {} as never);
		expect(room.project(context.plan.document)).toBe("# amber-river\n\nExisting body.\n");
		Service.departed(context.plan, person as never);
		at += 61_000;
		headingJob(context.plan);
		await headingTool(context).handler({ revision: 0, title: "Drafted" }, {} as never);
		expect(room.project(context.plan.document)).toBe("# Drafted\n\nExisting body.\n");
	} finally {
		clock.mockRestore();
	}
});
test("a person's edit of the title in the document is never redrafted", async () => {
	for (let typed of ["", "First draft"]) {
		let context = await opened("# \n\nExisting body.\n");
		context.backend.documentTitles = true;
		await Service.close(context.plan);
		context.plan = await Service.open(context.channel.id, context.backend, context.server);
		let plan = context.plan;
		headingJob(plan);
		await headingTool(context).handler({ revision: plan.revision, title: "Drafted" }, {} as never);
		expect(room.project(plan.document)).toBe("# Drafted\n\nExisting body.\n");
		let peer = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		let vector = Y.encodeStateVector(peer.doc);
		peer.editor.update(() => {
			let title = $getRoot().getFirstChild();
			if (!$isElementNode(title)) throw new Error("title missing");
			title.clear();
			if (typed) title.append($createTextNode(typed));
		}, { discrete: true });
		await room.settle();
		let ws = {
			data: { canEdit: true, room: plan.id, handle: "ana", client: "peer" },
			send() {},
			publish() {},
			close() {},
		} as unknown as Socket;
		Service.submit(plan, ws, {
			kind: "plan:update",
			ts: 0,
			rid: "title",
			id: "title",
			epoch: plan.document.epoch,
			update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString("base64"),
		});
		await Service.drain(plan);
		peer.doc.destroy();
		let kept = room.project(plan.document);
		expect(kept).toBe(`${typed ? `# ${typed}` : "#"}\n\nExisting body.\n`);
		await Service.close(plan);
		context.plan = await Service.open(context.channel.id, context.backend, context.server);
		headingJob(context.plan);
		let result = await headingTool(context).handler(
			{ revision: context.plan.revision, title: "Second draft" },
			{} as never,
		);
		expect(JSON.parse(String(result))).toMatchObject({ ok: true, changed: false });
		expect(room.project(context.plan.document)).toBe(kept);
	}
});

test("unchanged friendly or blank titles are successful no-ops", async () => {
	for (let title of ["Friendly otter", ""]) {
		let context = await opened(`# ${title}\n`);
		headingJob(context.plan);
		let before = room.project(context.plan.document);
		let result = await headingTool(context).handler({ revision: 0, title }, {} as never);
		expect(JSON.parse(String(result))).toMatchObject({ ok: true, changed: false, revision: 0 });
		expect(room.project(context.plan.document)).toBe(before);
		expect(context.plan.document.seq).toBe(0);
		expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(0);
	}
});

test("title-only writes accept 50 Unicode characters and escape Markdown punctuation", async () => {
	for (let title of ["😀".repeat(50), "# *Offline* retries [guide]"]) {
		let context = await opened("# \n\nExisting body.\n");
		headingJob(context.plan);
		let result = await headingTool(context).handler({ revision: 0, title }, {} as never);
		expect(JSON.parse(String(result))).toMatchObject({ ok: true, title });
		context.plan.document.editor.getEditorState().read(() => {
			expect(context.plan.document.editor.getEditorState().toJSON().root.children[0]).toMatchObject(
				{
					children: [{ text: title, format: 0 }],
				},
			);
		});
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
				{ ...INPUT, title: "😀".repeat(51) },
				{ ...INPUT, title: "First\rSecond" },
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

test("draft_heading rejects corrupt title text without changing the previous title or goal", async () => {
	let context = await opened("# Resurfacing old notes\n");
	headingJob(context.plan);
	context.plan.plannerTitle = "Resurfacing old notes";
	let before = room.project(context.plan.document);
	let stored = await context.storage.collaboration.load(context.channel.id, context.now);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		for (
			let title of [
				"Resurfacing old notes �00\u0017a9 \u0016e29 runtime=default",
				"Resurfacing old notes \u000000\u0017a9 \u0016e29 runtime=default",
				"Notes\u0000runtime=default",
				"Notes\u0085runtime=default",
				"Notes\ud800",
				"Notes\udc00",
			]
		) {
			let result = await headingTool(context).handler({ ...INPUT, title }, {} as never);
			expect(String(result)).toStartWith("Error:");
			expect(room.project(context.plan.document)).toBe(before);
			expect(context.plan.revision).toBe(0);
			expect(context.plan.document.seq).toBe(0);
			expect(context.plan.chat.jobOutput).toBeUndefined();
		}
	} finally {
		errors.mockRestore();
	}
	expect(context.broadcasts.filter(frame => frame.kind === "plan:update")).toHaveLength(0);
	expect(await context.storage.collaboration.load(context.channel.id, context.now)).toEqual(stored);
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
