import { describe, expect, it } from "bun:test";

import * as Tasks from "./graphs";
import { Graphs, restore } from "./graphs";

import type { Definition, Graph, GraphAdapter, Operation, Task } from "./graphs";

class Memory implements GraphAdapter<string> {
	graphs = new Map<string, Graph>();
	revisions = new Map<string, number>();

	async transact(
		document: string,
		change: (current: { graph: Graph | undefined; revision: number | undefined }) => {
			ok: true;
			value: Graph;
		} | { ok: false; reason: string },
	): Promise<{ ok: true; value: Graph } | { ok: false; reason: string }> {
		let result = change({
			graph: this.graphs.get(document),
			revision: this.revisions.get(document),
		});
		if (result.ok) this.graphs.set(document, result.value);
		return result;
	}
}

function definition(): Definition {
	return {
		tasks: [
			{
				id: "model",
				title: "Model the graph",
				context: "The graph is durable document state.",
				goal: "Define versioned task graphs.",
				acceptance: ["The graph has versions.", "Versions retain their plan revision."],
				dependsOn: [],
			},
			{
				id: "validate",
				title: "Validate task graphs",
				context: "The model protects implementation runs.",
				goal: "Reject invalid dependency graphs.",
				acceptance: ["Dependencies name known tasks.", "Cycles are refused."],
				dependsOn: ["model"],
			},
			{
				id: "report",
				title: "Report implementation progress",
				context: "Reporting has two independent prerequisites.",
				goal: "Connect reporting to the graph.",
				acceptance: [
					"The implementation can report progress.",
					"The report waits for both inputs.",
				],
				dependsOn: ["model", "validate"],
			},
			{
				id: "publish",
				title: "Publish the graph",
				context: "Publishing is unrelated to reporting.",
				goal: "Show independent roots.",
				acceptance: ["The graph can have multiple roots.", "Roots do not depend on each other."],
				dependsOn: [],
			},
		],
	};
}

function changed(): Definition {
	let next = definition();
	next.tasks[0].title = "Model approved task graphs";
	return next;
}

function add(definition: Definition): Operation[] {
	return definition.tasks.map(task => ({ op: "add", task }));
}

function stored(number: number, state: string): unknown {
	return { number, planRevision: 0, state, definition: definition() };
}

function run() {
	return {
		id: "run-1",
		user: "octocat",
		client: { name: "Codex", version: "1.2.3" },
		session: "session-1",
		planRevision: 7,
		graphRevision: 3,
		repository: "githubnext/chopin",
		branch: "tq/017",
		commit: "deadbeef",
		startedAt: "2026-08-17T12:00:00.000Z",
	};
}

async function expectGraph<T>(
	value: Promise<{ ok: true; value: T } | { ok: false; reason: string }>,
): Promise<T> {
	let result = await value;
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.reason);
	return result.value;
}

describe("implementation task graphs", () => {
	it("locks exactly the graph revision an implementation run records", () => {
		type Claim = (state: unknown, input: unknown) => unknown;
		type RestoreRun = (value: unknown, graph: unknown, revision: number) => unknown;
		let claim = (Tasks as typeof Tasks & { claim?: Claim }).claim;
		let restoreRun = (Tasks as typeof Tasks & { restoreRun?: RestoreRun }).restoreRun;
		expect(claim).toBeTypeOf("function");
		expect(restoreRun).toBeTypeOf("function");
		if (typeof claim !== "function" || typeof restoreRun !== "function") return;

		let approved: Graph = {
			versions: [{
				number: 1,
				revision: 3,
				planRevision: 7,
				state: "approved",
				definition: definition(),
			}],
		};
		let locked: Graph = {
			versions: [{ ...approved.versions[0]!, state: "locked" }],
		};
		let implementation = run();

		expect(claim(
			{ graph: approved, revision: 7, execution: undefined },
			{ planRevision: 7, graphRevision: 3, run: implementation },
		)).toMatchObject({
			kind: "started",
			graph: { versions: [{ state: "locked" }] },
			run: implementation,
		});
		expect(restoreRun(implementation, locked, 7)).toEqual(implementation);
		expect(restoreRun({ ...implementation, extra: true }, locked, 7)).toBeUndefined();
		expect(restoreRun(implementation, approved, 7)).toBeUndefined();
		expect(restoreRun(implementation, locked, 8)).toBeUndefined();
	});

	it("ignores an unreachable version history while preserving graph revision compatibility", () => {
		expect(restore({
			versions: [stored(1, "locked"), stored(2, "approved")],
		})).toBeUndefined();
		expect(restore({ versions: [stored(1, "draft")] })?.versions[0].revision).toBe(1);
	});

	it("persists a draft graph against the document revision with independent and joined work", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 7);
		let graphs = new Graphs(backend);

		let graph = await expectGraph(graphs.revise("plan", {
			planRevision: 7,
			graphRevision: 0,
			operations: add(definition()),
		}));

		expect(graph.versions).toEqual([expect.objectContaining({
			number: 1,
			state: "draft",
			planRevision: 7,
			definition: definition(),
		})]);
		expect(backend.graphs.get("plan")).toEqual(graph);
	});

	it("refuses a graph edit from an earlier graph read", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 7);
		let graphs = new Graphs(backend);
		let task = definition().tasks[0];
		let first = await graphs.revise("plan", {
			planRevision: 7,
			graphRevision: 0,
			operations: [{ op: "add", task }],
		});
		let stale = await graphs.revise("plan", {
			planRevision: 7,
			graphRevision: 0,
			operations: [{ op: "add", task: definition().tasks[1] }],
		});

		expect(first.ok).toBe(true);
		expect(stale).toEqual({ ok: false, reason: "stale-graph" });
		expect(backend.graphs.get("plan")?.versions[0].definition.tasks).toEqual([task]);
	});

	it("refuses duplicate ids, missing predecessors, self dependencies and cycles", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 1);
		let graphs = new Graphs(backend);
		let cases: Array<[string, Definition]> = [
			["duplicate", { tasks: [...definition().tasks, { ...definition().tasks[0] }] }],
			["missing", {
				tasks: [{ ...definition().tasks[0], dependsOn: ["absent"] }],
			}],
			["self", {
				tasks: [{ ...definition().tasks[0], dependsOn: ["model"] }],
			}],
			["cycle", {
				tasks: [
					{ ...definition().tasks[0], dependsOn: ["validate"] },
					{ ...definition().tasks[1], dependsOn: ["model"] },
				],
			}],
		];

		for (let [reason, invalid] of cases) {
			expect(
				await graphs.revise("plan", {
					planRevision: 1,
					graphRevision: 0,
					operations: add(invalid),
				}),
			).toEqual({ ok: false, reason });
		}
	});

	it("requires every task to have from two through eight acceptance criteria", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 1);
		let graphs = new Graphs(backend);
		let tooFew = definition();
		tooFew.tasks[0].acceptance = ["Only one."];
		let tooMany = definition();
		tooMany.tasks[0].acceptance = Array.from(
			{ length: 9 },
			(_, index) => `Criterion ${index + 1}.`,
		);

		expect(
			await graphs.revise("plan", {
				planRevision: 1,
				graphRevision: 0,
				operations: add(tooFew),
			}),
		).toEqual({ ok: false, reason: "acceptance" });
		expect(
			await graphs.revise("plan", {
				planRevision: 1,
				graphRevision: 0,
				operations: add(tooMany),
			}),
		).toEqual({ ok: false, reason: "acceptance" });
	});

	it("refuses malformed definition data instead of throwing at the persistence boundary", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 1);
		let graphs = new Graphs(backend);

		expect(
			await graphs.revise("plan", {
				planRevision: 1,
				graphRevision: 0,
				operations: [{ op: "add", task: { tasks: null } as unknown as Task }],
			}),
		).toEqual({
			ok: false,
			reason: "task",
		});
	});

	it("freezes an approved version and creates a new draft when it is edited", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 3);
		let graphs = new Graphs(backend);
		let created = await expectGraph(graphs.revise("plan", {
			planRevision: 3,
			graphRevision: 0,
			operations: add(definition()),
		}));
		let approved = await expectGraph(graphs.approve("plan"));

		expect(approved.versions[0]).toEqual({ ...created.versions[0], state: "approved" });
		let edited = await expectGraph(graphs.revise("plan", {
			planRevision: 3,
			graphRevision: 1,
			operations: [{ op: "replace", id: "model", task: changed().tasks[0] }],
		}));

		expect(edited.versions).toEqual([
			{ ...created.versions[0], state: "approved" },
			expect.objectContaining({
				number: 2,
				state: "draft",
				planRevision: 3,
				definition: changed(),
			}),
		]);
		let replacement = await expectGraph(graphs.approve("plan"));
		expect(replacement.versions.map(version => version.state)).toEqual(["superseded", "approved"]);
	});

	it("does not start an old graph and locks one that starts against its plan revision", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 5);
		let graphs = new Graphs(backend);
		await expectGraph(graphs.revise("plan", {
			planRevision: 5,
			graphRevision: 0,
			operations: add(definition()),
		}));
		await expectGraph(graphs.approve("plan"));

		backend.revisions.set("plan", 6);
		expect(await graphs.start("plan")).toEqual({ ok: false, reason: "stale-plan" });

		let replacement = await expectGraph(graphs.revise("plan", {
			planRevision: 6,
			graphRevision: 1,
			operations: [{ op: "replace", id: "model", task: changed().tasks[0] }],
		}));
		expect(replacement.versions[1]).toMatchObject({ state: "draft", planRevision: 6 });
		await expectGraph(graphs.approve("plan"));
		let locked = await expectGraph(graphs.start("plan"));

		expect(locked.versions[1]).toMatchObject({ state: "locked", planRevision: 6 });
		expect(
			await graphs.revise("plan", {
				planRevision: 6,
				graphRevision: 1,
				operations: [{ op: "add", task: definition().tasks[0] }],
			}),
		).toEqual({ ok: false, reason: "locked" });
	});

	it("applies planner task operations only against the graph revision it read", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 7);
		let graphs = new Graphs(backend);
		await expectGraph(graphs.revise("plan", {
			planRevision: 7,
			graphRevision: 0,
			operations: definition().tasks.map(task => ({ op: "add", task })),
		}));

		let result = await expectGraph(graphs.revise("plan", {
			planRevision: 7,
			graphRevision: 1,
			operations: [
				{
					op: "replace",
					id: "model",
					task: {
						...definition().tasks[0],
						title: "Model planner graph revisions",
					},
				},
				{
					op: "add",
					task: {
						id: "tools",
						title: "Give the planner graph tools",
						context: "The planner works through constrained server tools.",
						goal: "Draft and revise task graphs without changing plan prose.",
						acceptance: [
							"The planner reads the current graph before editing it.",
							"Planner graph edits leave plan source unchanged.",
						],
						dependsOn: ["model"],
					},
				},
				{
					op: "replace",
					id: "report",
					task: { ...definition().tasks[2], dependsOn: ["model"] },
				},
				{ op: "remove", id: "validate" },
				{ op: "reorder", ids: ["publish", "model", "tools", "report"] },
			],
		}));

		let current = result.versions.at(-1);
		if (!current) throw new Error("planner revision was missing");
		expect(current.planRevision).toBe(7);
		expect(current.revision).toBe(2);
		expect(current.definition.tasks.find(task => task.id === "model")?.title)
			.toBe("Model planner graph revisions");
		expect(current.definition.tasks.find(task => task.id === "tools")?.dependsOn).toEqual([
			"model",
		]);
		expect(current.definition.tasks.map(task => task.id))
			.toEqual(["publish", "model", "tools", "report"]);

		let before = structuredClone(result);
		backend.revisions.set("plan", 8);
		expect(
			await graphs.revise("plan", {
				planRevision: 7,
				graphRevision: 2,
				operations: [],
			}),
		).toEqual({ ok: false, reason: "stale-plan" });
		expect(backend.graphs.get("plan")).toEqual(before);

		expect(
			await graphs.revise("plan", {
				planRevision: 8,
				graphRevision: 1,
				operations: [],
			}),
		).toEqual({ ok: false, reason: "stale-graph" });
		expect(backend.graphs.get("plan")).toEqual(before);
	});
});
