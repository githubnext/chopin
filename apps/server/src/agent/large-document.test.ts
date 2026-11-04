import { afterEach, expect, spyOn, test } from "bun:test";

import { currentPlan, documentView } from "./document-ops";
import { plannerInstructions } from "./planner";
import { readingOutput } from "./reading-output";
import { type DocumentRoom, documentTools } from "./tools";
import { READ_BYTES } from "../document-reading";
import {
	ATOMIC_KEEPS,
	atomicShows,
	fieldNotes,
	readAll,
	reading,
} from "../document-reading.test-fixtures";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";

let plans: Awaited<ReturnType<typeof Service.open>>[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

async function roomFor(source: string) {
	let fixture = await openPlan(source);
	plans.push(fixture.plan);
	let room: DocumentRoom = {
		id: fixture.plan.id,
		plan: fixture.plan,
		server: fixture.server,
		persist: () => Service.persist(fixture.plan),
		exclusive: action => Service.exclusive(fixture.plan, action),
		publish: async () => {},
		anchors: () => {},
		changes: () => {},
	};
	let owner = { signal: new AbortController().signal, revalidate: async () => true };
	let run = (tool: "read_plan" | "open_decisions", input: unknown) =>
		documentTools[tool].execute!(input as never, {
			toolCallId: tool,
			messages: [],
			context: { room, owner },
		} as never) as Promise<string>;
	/** What a model reads of `read_plan`: the harness shows it this, not the tool's own result. */
	let model = async (input: Record<string, unknown>) =>
		readingOutput({ toolName: "read_plan", input, output: await run("read_plan", input) })!;
	return { ...fixture, room, run, model };
}

let large = () => roomFor(fieldNotes(170_000));

test(
	"read_plan's own result is still the whole structured view as JSON",
	async () => {
		let { plan, run } = await large();
		let output = await run("read_plan", {});
		expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(await documentView(plan))));
		let view = JSON.parse(output) as Record<string, unknown> & {
			source: string;
			blocks: unknown[];
		};
		expect(Object.keys(view)).toEqual([
			"document",
			"revision",
			"source",
			"blocks",
			"comments",
			"questions",
		]);
		expect(view.source).toBe(Room.project(plan.document));
		expect(view.blocks.length).toBeGreaterThan(1_000);
		expect(view.blocks[0]).toEqual({
			index: 0,
			type: "heading",
			preview: "Quarterly field notes",
			digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
	},
	120_000,
);

test(
	"the model reads a document of about 170,000 characters as outline, first part and next",
	async () => {
		let { plan, model } = await large();
		let source = Room.project(plan.document);
		expect(source.length).toBeGreaterThan(160_000);

		let first = await model({});
		let read = reading(first);
		expect(Buffer.byteLength(first)).toBeLessThanOrEqual(READ_BYTES);
		expect(READ_BYTES).toBeLessThan(ATOMIC_KEEPS);
		expect(atomicShows(first)).toBe(first);
		expect(first.split("\n").length).toBeGreaterThan(100);
		expect(first).not.toStartWith("{");
		expect(read.fields.revision).toBe(String(plan.revision));
		expect(read.fields.document).toBe(plan.id);
		expect(read.outline.slice(0, 2)).toEqual([
			"L1 # Quarterly field notes",
			"L3 ## Site 1: harbour survey",
		]);
		expect(read.next).toEqual({ offset: read.range[1] + 1 });
		expect(source.startsWith(read.source)).toBe(true);
		expect(first).not.toContain(source);
	},
	120_000,
);

test(
	"following next through read_plan reads every character once and lists every block once",
	async () => {
		let { plan, run } = await large();
		let source = Room.project(plan.document);
		let view = await documentView(plan) as { blocks: Array<{ index: number; digest: string }> };
		let output = await run("read_plan", {});
		let { source: joined, pages } = await readAll(async at =>
			readingOutput({ toolName: "read_plan", input: at, output })!
		);

		expect(pages.length).toBeGreaterThan(10);
		expect(joined).toBe(source);
		let listed = pages.flatMap(page => page.blocks);
		expect(listed.map(block => block.index)).toEqual(view.blocks.map(block => block.index));
		expect(listed.map(block => block.digest)).toEqual(view.blocks.map(block => block.digest));
		for (let page of pages) {
			for (let block of page.blocks) {
				expect(block.lines[0]).toBeGreaterThanOrEqual(page.range[0]);
				expect(block.lines[0]).toBeLessThanOrEqual(page.range[1]);
			}
		}
	},
	120_000,
);

test("read_plan returns exactly the lines asked for, or says why it stopped short", async () => {
	let { plan, model } = await large();
	let all = Room.project(plan.document).split("\n");
	let slice = reading(await model({ offset: 2_000, limit: 5 }));
	expect(slice.source).toBe(`${all.slice(1_999, 2_004).join("\n")}\n`);
	expect(slice.fields.lines).toBe(`2000-2004 of ${all.length - 1}`);
	expect(slice.next).toEqual({ offset: 2_005 });
	expect(slice.outline).toEqual([]);

	let asked = await model({ offset: 1, limit: 2_000 });
	let clipped = reading(asked);
	expect(Buffer.byteLength(asked)).toBeLessThanOrEqual(READ_BYTES);
	expect(clipped.range[1]).toBeLessThan(2_000);
	expect(clipped.fields.limit).toContain(`asked for 2000 lines from line 1`);
	expect(clipped.next).toEqual({ offset: clipped.range[1] + 1 });

	let last = reading(await model({ offset: all.length - 1 }));
	expect(last.source).toBe(`${all.at(-2)!}\n`);
	expect(last.next).toBeUndefined();
});

test("read_plan refuses a range outside the document with the line count", async () => {
	let { plan, run } = await large();
	let lines = Room.project(plan.document).split("\n").length - 1;
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		expect(await run("read_plan", { offset: lines + 1 })).toContain(
			`outside the document, which has ${lines} lines`,
		);
		expect(await run("read_plan", { offset: 0 })).toContain("`offset` must be an integer");
		expect(await run("read_plan", { column: 3 })).toContain("pass `offset` with it");
		expect(await run("read_plan", { offset: 1, column: 9_999 })).toContain("outside line 1");
		expect(await run("read_plan", { lines: 3 })).toContain("unexpected field");
	} finally {
		errors.mockRestore();
	}
	expect(
		readingOutput({
			toolName: "read_plan",
			input: { offset: 0 },
			output: "Error: `offset` must be an integer of at least 1.",
		}),
	).toBeUndefined();
});

test("a plan of one 170,000-character paragraph is read in pieces through read_plan's column", async () => {
	let paragraph = "The crew counted moored boats along the north quay. ".repeat(3_400);
	let source = `# Quarterly field notes\n\n${paragraph}\n\nEnd.\n`;
	let { plan, model } = await roomFor(source);
	let { source: joined, pages } = await readAll(at => model(at));
	expect(joined).toBe(Room.project(plan.document));
	expect(pages.length).toBeGreaterThan(10);
	expect(pages.some(page => page.next?.column !== undefined)).toBe(true);
});

test(
	"open_decisions keeps the revision but not the 170,000-character body, within the budget",
	async () => {
		let { plan, run } = await large();
		let digests = Room.digests(plan.document);
		let result = await run("open_decisions", {
			revision: plan.revision,
			questions: [{
				key: "harbour-decision",
				header: "Survey",
				question: "Which quay should the next survey start from?",
				response: "text",
				options: [],
				multiple: false,
				blocks: [{ index: 2, digest: digests[2]! }],
			}],
		});
		let parsed = JSON.parse(result);
		expect(Buffer.byteLength(result)).toBeLessThan(READ_BYTES);
		expect(Buffer.byteLength(result)).toBeLessThan(ATOMIC_KEEPS);
		expect(parsed.decisions).toEqual([{
			key: "harbour-decision",
			id: expect.any(String),
			status: "open",
		}]);
		expect(parsed.current_plan.revision).toBe(plan.revision);
		expect(parsed.current_plan.document.id).toBe(plan.id);
		expect(parsed.current_plan.source).toBeUndefined();
		expect(parsed.current_plan.blocks).toBeUndefined();
		expect(parsed.current_plan.questions).toEqual([
			expect.objectContaining({ id: parsed.decisions[0].id, status: "open" }),
		]);
		expect(parsed.current_plan.source_omitted.read).toContain("read_plan");
		expect(parsed.current_plan.source_omitted.characters).toBe(Room.project(plan.document).length);
	},
	120_000,
);

test("a current plan with hundreds of decisions and comments still fits one read, newest kept", () => {
	let view = {
		document: { id: "d", url: "/documents/o/r/notes" },
		revision: 3,
		source: "x".repeat(50_000),
		blocks: Array.from({ length: 600 }, (_, index) => ({ index })),
		comments: Array.from(
			{ length: 200 },
			(_, index) => ({ id: `c${index}`, comments: ["y".repeat(300)] }),
		),
		questions: Array.from({ length: 500 }, (_, index) => ({
			id: `q${index}`,
			status: "open",
			questions: ["Which quay?"],
			options: [["North"], ["South"]],
		})),
	};
	let reduced = currentPlan(view, "read_plan") as Record<string, unknown> & {
		questions: Array<{ id: string }>;
		comments: Array<{ id: string }>;
	};
	expect(Buffer.byteLength(JSON.stringify(reduced))).toBeLessThan(READ_BYTES);
	expect(reduced.revision).toBe(3);
	expect(reduced.source).toBeUndefined();
	expect(reduced.questions.at(-1)!.id).toBe("q499");
	expect(reduced.questions.length + (reduced.questions_omitted as number)).toBe(500);
	expect(reduced.comments.at(-1)!.id).toBe("c199");
	expect(reduced.comments.length + (reduced.comments_omitted as number)).toBe(200);
	expect(
		currentPlan({ ...view, source: "x", blocks: [], comments: [], questions: [] }, "read_plan"),
	)
		.toEqual({ ...view, source: "x", blocks: [], comments: [], questions: [] });
});

test("the Planner prompt and the tool tell the model the byte budget and how to continue", () => {
	let prompt = plannerInstructions("octo-org/score");
	expect(prompt).toContain(`One result holds at most ${READ_BYTES.toLocaleString("en-US")}`);
	expect(prompt).toContain("`next:` call");
	expect(prompt).toContain("`column`");
	let description = documentTools.read_plan.description!;
	expect(description).toContain(`${READ_BYTES.toLocaleString("en-US")} bytes in all`);
	expect(description).toContain("`column`");
	expect(description).not.toContain("30,000");
});

test("open_decisions on a small document still returns the whole current plan", async () => {
	let { plan, run } = await roomFor("# Draft\n\nProvisional onboarding.\n");
	let result = JSON.parse(
		await run("open_decisions", {
			revision: plan.revision,
			questions: [{
				key: "onboarding-1",
				header: "Onboarding",
				question: "How should onboarding work?",
				response: "text",
				options: [],
				multiple: false,
				blocks: [{ index: 1, digest: Room.digests(plan.document)[1]! }],
			}],
		}),
	);
	expect(result.current_plan.source).toContain("Provisional onboarding.");
	expect(result.current_plan.blocks.length).toBeGreaterThan(0);
	expect(result.current_plan.source_omitted).toBeUndefined();
});
