import { expect, spyOn, test } from "bun:test";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import * as Store from "../questions/store";
import { createRefineToolFixture } from "./refine-tool.test-fixtures";

let contexts: ReturnType<typeof createRefineToolFixture>["contexts"];
let fixture = createRefineToolFixture(() => contexts, value => {
	contexts = value;
});
contexts = fixture.contexts;
let { OPTION, opened, job, call, d01Messages } = fixture;

test("a valid D01 m1 question source cannot source Rob's m2 editor options", async () => {
	let context = await opened();
	let { m2, ref } = d01Messages(context);
	job(context.plan, context.id);
	let beforeDocument = room.project(context.plan.document);
	let beforeRecord = structuredClone(context.plan.records.get(context.id)!);
	let errors = spyOn(console, "error").mockImplementation(() => {});
	try {
		let answer = await call(context, {
			revision: context.plan.revision,
			id: context.id,
			title: "Which rich-text editor should we use?",
			add_options: [{
				label: "Tiptap",
				rationale: `Rob proposed it in m2: ${m2.text}`,
				source: ref,
			}],
		});

		expect(answer).toContain("option question source does not name this card option");
		expect(answer).not.toContain("invalid conversation source");
		expect(answer).not.toContain("source-shape");
		expect(room.project(context.plan.document)).toBe(beforeDocument);
		expect(context.plan.records.get(context.id)).toEqual(beforeRecord);
	} finally {
		errors.mockRestore();
	}
});

test("refine_decision retitles, adds a reasoned option, and durably places the card", async () => {
	let context = await opened([{ id: OPTION, label: "Anchors" }]);
	job(context.plan, context.id);
	let digest = room.digests(context.plan.document)[0]!;
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			title: "Which auth system should ship first?",
			add_options: [{ label: "GitHub Apps", rationale: "Fits repository permissions." }],
			place_after: { index: 0, digest },
		}),
	);
	expect(answer).toMatchObject({
		ok: true,
		title: "Which auth system should ship first?",
		placed: true,
		skipped: [],
		full: [],
	});
	expect(answer.added).toHaveLength(1);
	let record = context.plan.records.get(context.id)!;
	expect(record.definition.questions[0]?.question).toBe("Which auth system should ship first?");
	expect(record.optionOrigins[answer.added[0]]).toEqual({
		origin: "planner",
		rationale: "Fits repository permissions.",
	});
	let source = room.project(context.plan.document);
	expect(source.indexOf("Opening prose.")).toBeLessThan(source.indexOf("<Questionnaire"));
	expect(source.indexOf("<Questionnaire")).toBeLessThan(source.indexOf("Later prose."));
	expect(source).toContain('prompt="Which auth system should ship first?"');
	expect(JSON.parse(context.plan.chat.jobOutput!)).toEqual({
		title: "Which auth system should ship first?",
		added: 1,
	});
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	expect((await Service.readStored(loaded)).source).toBe(source);
	expect(Store.get(context.plan.questions, context.id)?.definition.questions[0]?.question).toBe(
		"Which auth system should ship first?",
	);
});

test("refine_decision skips case-folded duplicates and stops at ten options", async () => {
	let options = Array.from({ length: 9 }, (_, index) => ({
		id: `01K0N4W3B7P27CBAEC7A8C8W${String(index).padStart(2, "0")}`,
		label: index === 0 ? "Anchors" : `Option ${index}`,
	}));
	let context = await opened(options);
	job(context.plan, context.id);
	let answer = JSON.parse(
		await call(context, {
			revision: context.plan.revision,
			id: context.id,
			add_options: [
				{ label: " anchors ", rationale: "Already discussed." },
				{ label: "Export", rationale: "Frequently requested." },
				{ label: "Import", rationale: "Could follow export." },
			],
		}),
	);
	expect(answer.added).toHaveLength(1);
	expect(answer.skipped).toEqual(["anchors"]);
	expect(answer.full).toEqual(["Import"]);
	expect(context.plan.records.get(context.id)?.definition.questions[0]?.options).toHaveLength(10);
});
