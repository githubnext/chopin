import { expect, test } from "bun:test";
import { options } from "./options";
import { sanitizer } from "./sanitize";
import { scenarioHash, scenarios, select } from "./scenarios";
import { mechanical, scorecard } from "./review";
import { scriptedHarness } from "./test-fixtures";
import { finishWithin, runScenario } from "./runner";
import { scenarioSession } from "./session";
import { leaseDuration, turnPrompt } from "./prompt";
import { openPlan } from "../../apps/server/src/testing/plan";
import type { Scenario } from "./types";

let scenario: Scenario = {
	id: "plumbing",
	title: "Runner plumbing",
	source: "# Test\n",
	turns: [{ speaker: "Alex", text: "Develop this." }, { speaker: "Alex", text: "Correct it." }],
	expectations: [],
	maxQuestions: 1,
	requiresEvidence: true,
};
let settings = {
	token: "test-token",
	instructions: "Test tool execution only.",
	model: "test",
	visual: "off" as const,
	limits: { maxTools: 5, turnTimeoutMs: 2_000, questionWaitMs: 100 },
};
let edit = {
	name: "edit_plan",
	input: (value: unknown) => ({
		revision: JSON.parse(value as string).revision,
		operations: [{ op: "insert_root", source: "Provisional understanding." }],
	}),
};

test("CLI requires explicit live opt-in, safe run identity and bounded options", () => {
	expect(options([]).live).toBe(false);
	expect(options([]).model).toBe("gpt-6-luna");
	expect(() => options(["--live"])).toThrow("--instructions");
	expect(() => options(["--run-id", "../previous"])).toThrow("safe directory");
	expect(() => options(["--max-tools", "51"])).toThrow();
	expect(() => options(["--cases", "factual-answer,factual-answer"])).toThrow();
});

test("frozen cohort includes eleven cases, two followups and explicit pause", () => {
	expect(scenarios).toHaveLength(11);
	expect(scenarioHash).toHaveLength(64);
	expect(select(["coworker-confusion", "user-correction"]).every(item => item.turns.length === 2))
		.toBe(true);
	expect(select(["pause-dismiss"])[0].turns[0].stopWrites).toBe(true);
	expect(() => select(["invented"])).toThrow();
});

test("artifacts redact exact credentials, GitHub tokens and Bearer headers", () => {
	let clean = sanitizer(["secret-credential"]);
	expect(
		clean({
			text: "secret-credential ghp_ABC123 Bearer opaque",
			error: new Error("secret-credential"),
		}),
	)
		.not.toContain("secret-credential");
	expect(clean("github_pat_TEST Bearer opaque")).toBe("[REDACTED] Bearer [REDACTED]");
});

test("real document tools persist provisional prose across two scripted turns", async () => {
	let fake = scriptedHarness([[{ name: "read_plan", input: {} }, edit], [
		{ name: "read_repository_file", input: { path: "docs/decisions.md" } },
		{ name: "read_plan", input: {} },
		edit,
	]]);
	let result = await runScenario(scenario, { ...settings, harness: fake.harness });
	expect(result.failures).toEqual([]);
	expect(result.turns.map(turn => turn.status)).toEqual(["complete", "complete"]);
	expect(result.finalRevision).toBe(2);
	expect(result.durableDocument?.matchesLiveSource).toBe(true);
	expect(result.durableDocument?.source).toBe(result.finalSource);
	expect(result.durableDocument?.storageRevision).toBeGreaterThan(0);
	expect(result.turns[1].prompt).toBe(turnPrompt([result.turns[0]], scenario.turns[1]));
	expect(result.tools.filter(trace => trace.name === "edit_plan")).toHaveLength(2);
	expect(mechanical(result).every(check => check.status !== "fail")).toBe(true);
	expect(scorecard([result]).cases[0].axes.every(axis => axis.score === null)).toBe(true);
	expect(fake.destroyed()).toBe(1);
});

test("tool cap aborts before another mutation and sends no next turn", async () => {
	let fake = scriptedHarness([[{ name: "read_plan", input: {} }, edit], []]);
	let result = await runScenario(scenario, {
		...settings,
		harness: fake.harness,
		limits: { ...settings.limits, maxTools: 1 },
	});
	expect(result.failures).toContain("Tool call cap exceeded");
	expect(result.finalRevision).toBe(0);
	expect(result.turns).toHaveLength(1);
	expect(result.turns[0].status).toBe("failed");
	expect(fake.prompted()).toBe(1);
});

test("explicit human stop refuses attempted mutation without modifying the document", async () => {
	let fake = scriptedHarness([[{ name: "read_plan", input: {} }, edit]]);
	let stopped = { ...scenario, turns: [{ ...scenario.turns[0], stopWrites: true }] };
	let result = await runScenario(stopped, { ...settings, harness: fake.harness });
	expect(result.finalRevision).toBe(0);
	expect(result.failures).toContain("Mutation attempted after explicit stop: edit_plan");
	expect(mechanical(result).find(check => check.id === "no-mutation-after-stop")?.status).toBe(
		"fail",
	);
});

test("an unanswered real ask is withdrawn at the bound, then case stops before followup", async () => {
	let fake = scriptedHarness([[{ name: "read_plan", input: {} }, {
		name: "ask",
		input: (value: unknown) => {
			let view = JSON.parse(value as string);
			return {
				revision: view.revision,
				questions: [{
					header: "Timing",
					question: "When should export happen?",
					options: [{ label: "Manual", description: "Export explicitly." }],
					multiple: false,
					blocks: [{ index: view.blocks[0].index, digest: view.blocks[0].digest }],
				}],
			};
		},
	}], []]);
	let result = await runScenario(scenario, { ...settings, harness: fake.harness });
	expect(result.turns).toHaveLength(1);
	expect(result.turns[0].status).toBe("awaiting-human");
	expect(fake.prompted()).toBe(1);
	expect(result.tools.find(trace => trace.name === "ask")?.revisionAfter).toBeDefined();
});

test("cleanup joining is bounded and cannot pretend an unresolved stream has stopped", async () => {
	await expect(finishWithin(new Promise(() => {}), 10)).rejects.toThrow("Cleanup deadline");
});

test("a short owned memory lease is extended over the complete bounded case before tools run", async () => {
	let fake = scriptedHarness([]);
	let fixture = await scenarioSession(scenario, {
		...settings,
		harness: fake.harness,
		limits: { ...settings.limits, turnTimeoutMs: 120_000 },
	}, {
		openPlan: async source => {
			let context = await openPlan(source);
			await context.storage.leases.renew(context.lease, 5_000);
			return context;
		},
	});
	try {
		expect(leaseDuration(2, 120_000)).toBe(340_000);
		expect(fixture.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(300_000);
		let stored = await fixture.storedDocument();
		expect(stored.source).toBe(fixture.source());
	} finally {
		await fixture.close();
	}
});

test("an inactive stream tool-call with no execution trace fails the authority check", () => {
	let result = {
		scenario,
		initialSource: scenario.source,
		finalSource: scenario.source,
		finalRevision: 0,
		tools: [],
		activeTools: ["read_plan"],
		failures: [],
		turns: [{
			number: 1,
			human: scenario.turns[0],
			prompt: "",
			text: "",
			status: "complete" as const,
			failures: [],
			parts: [{ type: "tool-call", toolName: "bash", toolCallId: "denied", input: {} }],
		}],
	};
	let check = mechanical(result).find(check => check.id === "tool-authority");
	expect(check?.status).toBe("fail");
	expect(check?.detail).toContain("turns/1/parts/0: bash");
});
