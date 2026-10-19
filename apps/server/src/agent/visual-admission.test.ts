import { expect, test } from "bun:test";

import type { Decide } from "../conversation-plan/decisions";
import type { JevRequest, JevResult } from "../conversation-plan/jev";
import { createVisualAdmission } from "./visual-admission";
import { visualExample } from "./visual-catalog";

let passage = "The client sends a request to the server. The server returns its response.";
let second = "A worker receives a queued job, runs it, and records the result.";
let diagram = (type = "sequence") =>
	`\`\`\`seecode\n${JSON.stringify(visualExample(type))}\n\`\`\``;

function classifier(choice = "sequence", requests: JevRequest[] = []): Decide {
	return async request => {
		requests.push(request);
		let answers: JevResult["answers"] = {};
		for (let [key, question] of Object.entries(request.questions)) {
			answers[key] = question.type === "choice"
				? { type: "choice", choice, confidence: 0.9, probabilities: {} }
				: { type: "noul", noul: choice === "prose" ? 0.1 : 0.9 };
		}
		return {
			model: "admission-test",
			answers,
			usage: { input_tokens: 1, output_tokens: 1 },
			latencyMs: 1,
		};
	};
}

let failing: Decide = async () => {
	throw new Error("provider unavailable");
};
let uncertain: Decide = async request => ({
	model: "admission-test",
	answers: Object.fromEntries(
		Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.5 }]),
	),
	usage: { input_tokens: 1, output_tokens: 1 },
	latencyMs: 1,
});

test("a new full draft must satisfy every assessed passage", async () => {
	let requests: JevRequest[] = [];
	let admit = createVisualAdmission(classifier("sequence", requests));
	let issues = await admit({ sources: [`# Requests\n\n${passage}\n\n## Jobs\n\n${second}`] });
	expect(issues).toHaveLength(2);
	expect(issues.every(issue => issue.code === "E_VISUAL_REQUIRED")).toBe(true);
	expect(issues[0]!.message).toContain("sequence");
	expect(issues[0]!.message).toContain("seecode");
	expect(issues[0]!.message).toContain('"type":"sequence"');
	expect(issues[0]!.message).toContain("Participants");
	expect(issues[0]!.path).not.toBe(issues[1]!.path);
	expect((requests[0]!.state as { passages: unknown[] }).passages).toHaveLength(2);
});

test("all passages are assessed in batches of at most eight", async () => {
	let requests: JevRequest[] = [];
	let sources = Array.from({ length: 17 }, (_, i) => `Passage ${i} records an isolated fact.`);
	expect(await createVisualAdmission(classifier("prose", requests))({ sources })).toEqual([]);
	expect(requests.map(request => Object.keys(request.questions).length)).toEqual([8, 8, 1]);
});

test("escaped passage batches respect the decisions state bound without dropping content", async () => {
	let requests: JevRequest[] = [];
	let decide = classifier("prose", requests);
	let admit = createVisualAdmission(async (request, options) => {
		if (JSON.stringify(request.state).length > 24_000) throw new Error("invalid decision request");
		return decide(request, options);
	});
	let sources = Array.from(
		{ length: 8 },
		(_, index) => `Passage ${index}: \`${"\\".repeat(1600)}\``,
	);
	expect(await admit({ sources })).toEqual([]);
	expect(requests.flatMap(request => Object.keys(request.questions))).toHaveLength(8);
});

test("a native diagram must render and match the selected type", async () => {
	let admit = createVisualAdmission(classifier());
	expect(await admit({ sources: [`${passage}\n\n${diagram()}`] })).toEqual([]);
	expect((await admit({ sources: [`${passage}\n\n${diagram("flowchart")}`] }))[0]!.code)
		.toBe("E_VISUAL_REQUIRED");
	expect(
		(await admit({
			sources: [`${passage}\n\n\`\`\`seecode\n{"type":"sequence"}\n\`\`\``],
		}))[0]!.code,
	).toBe("E_VISUAL_INVALID");
});

test("a selected comparison table requires an actual valid native table", async () => {
	let admit = createVisualAdmission(classifier("table"));
	expect((await admit({ sources: [passage] }))[0]!.message).toContain("table");
	expect(
		await admit({
			sources: [`${passage}\n\n| Part | Role |\n| --- | --- |\n| Client | Sends requests |`],
		}),
	).toEqual([]);
});

test("a successful prose judgment accepts prose without a diagram quota", async () => {
	expect(await createVisualAdmission(classifier("prose"))({ sources: [passage, second] }))
		.toEqual([]);
});

test("nested prose and complete lists reach assessment", async () => {
	let requests: JevRequest[] = [];
	let sources = [
		`<Callout type="info">\n\n${passage}\n\n</Callout>`,
		"- Input enters the queue.\n- A worker reads the queue.\n  - It records completion.",
	];
	let issues = await createVisualAdmission(classifier("sequence", requests))({ sources });
	expect(issues).toHaveLength(2);
	let assessed = JSON.stringify(requests[0]!.state);
	expect(assessed).toContain("records completion");
	expect(assessed).toContain(passage);
});

test("missing, failed, aborted, and uncertain assessment fail closed", async () => {
	let unavailable = await createVisualAdmission(undefined)({ sources: [passage] });
	expect(unavailable[0]!.code).toBe("E_VISUAL_ASSESSMENT");
	expect((await createVisualAdmission(failing)({ sources: [passage] }))[0]!.code)
		.toBe("E_VISUAL_ASSESSMENT");
	let controller = new AbortController();
	controller.abort();
	expect(
		(await createVisualAdmission(classifier("prose"))({
			sources: [passage],
			signal: controller.signal,
		}))[0]!.code,
	).toBe("E_VISUAL_ASSESSMENT");
	expect((await createVisualAdmission(uncertain)({ sources: [passage] }))[0]!.code)
		.toBe("E_VISUAL_ASSESSMENT");
});

test("diagram repair retains the successful assessment but failure is retried", async () => {
	let requests: JevRequest[] = [];
	let decide = classifier("sequence", requests);
	let fail = true;
	let admit = createVisualAdmission(async (request, options) => {
		if (fail) {
			fail = false;
			throw new Error("temporary provider failure");
		}
		return decide(request, options);
	});
	expect((await admit({ sources: [passage] }))[0]!.code).toBe("E_VISUAL_ASSESSMENT");
	expect((await admit({ sources: [passage] }))[0]!.code).toBe("E_VISUAL_REQUIRED");
	expect(requests).toHaveLength(3);
	expect(await admit({ sources: [`${passage}\n\n${diagram()}`] })).toEqual([]);
	expect(requests).toHaveLength(3);
});

test("unchanged passage and visual are skipped, but removing the visual is reassessed", async () => {
	let before = `${passage}\n\n${diagram()}`;
	let requests: JevRequest[] = [];
	let admit = createVisualAdmission(classifier("sequence", requests));
	expect(await admit({ before, sources: [before] })).toEqual([]);
	expect(requests).toHaveLength(0);
	expect((await admit({ before, sources: [passage] }))[0]!.code).toBe("E_VISUAL_REQUIRED");
	expect(requests).toHaveLength(3);
});

test("oversized passages return actionable bounded issues without truncating assessment", async () => {
	let requests: JevRequest[] = [];
	let issues = await createVisualAdmission(classifier("prose", requests))({
		sources: ["A".repeat(2_001)],
	});
	expect(issues[0]!.code).toBe("E_VISUAL_LIMIT");
	expect(issues[0]!.message).toContain("2000");
	expect(requests).toHaveLength(0);
});

test("unchanged human prose does not block an unrelated write or consume classifier calls", async () => {
	let before = `# Human writing\n\n${"A".repeat(2_001)}`;
	let requests: JevRequest[] = [];
	let admit = createVisualAdmission(classifier("sequence", requests));
	expect(await admit({ before, sources: [`${before}\n\n## New heading`] })).toEqual([]);
	expect(requests).toEqual([]);
});

test.each(["Original title", "Original section"])(
	"renaming %s preserves an unchanged oversized human paragraph",
	async heading => {
		let before = `# Original title\n\n## Original section\n\n${"A".repeat(2_001)}`;
		let after = before.replace(heading, "Renamed heading");
		expect(await createVisualAdmission(undefined)({ before, sources: [after] })).toEqual([]);
	},
);

test("heading-only renames preserve an existing passage and visual without a classifier", async () => {
	let before = `# Original title\n\n## Original section\n\n${passage}\n\n${diagram()}`;
	let after = before.replace("Original title", "New title").replace(
		"Original section",
		"New section",
	);
	expect(await createVisualAdmission(undefined)({ before, sources: [after] })).toEqual([]);
});

test.each(["changed", "new"])(
	"a heading rename still assesses %s prose with its new context",
	async kind => {
		let before = `# Original title\n\n## Transport\n\n${passage}`;
		let after = `# Renamed title\n\n## Transport\n\n${
			kind === "new" ? `${passage}\n\n${second}` : second
		}`;
		let requests: JevRequest[] = [];
		let issues = await createVisualAdmission(classifier("sequence", requests))({
			before,
			sources: [after],
		});
		expect(issues).toHaveLength(1);
		expect(issues[0]!.code).toBe("E_VISUAL_REQUIRED");
		expect((requests[0]!.state as { passages: unknown[] }).passages).toEqual([{
			index: 0,
			source: `# Renamed title\n## Transport\n\n${second}`,
		}]);
	},
);

test.each(["removed", "changed"])(
	"renaming a heading still reassesses a passage whose visual was %s",
	async kind => {
		let before = `# Original title\n\n${passage}\n\n${diagram()}`;
		let after = `# Renamed title\n\n${passage}${
			kind === "changed" ? `\n\n${diagram("flowchart")}` : ""
		}`;
		let requests: JevRequest[] = [];
		let issues = await createVisualAdmission(classifier("sequence", requests))({
			before,
			sources: [after],
		});
		expect(issues[0]!.code).toBe("E_VISUAL_REQUIRED");
		expect(requests).toHaveLength(3);
	},
);
