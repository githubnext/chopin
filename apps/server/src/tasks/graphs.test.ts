import { describe, expect, it } from "bun:test";

import { Graphs } from "./graphs";

import type { Definition, Graph, GraphAdapter } from "./graphs";

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

async function expectGraph<T>(
	value: Promise<{ ok: true; value: T } | { ok: false; reason: string }>,
): Promise<T> {
	let result = await value;
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.reason);
	return result.value;
}

describe("implementation task graphs", () => {
	it("persists a draft graph against the document revision with independent and joined work", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 7);
		let graphs = new Graphs(backend);

		let graph = await expectGraph(graphs.create("plan", definition()));

		expect(graph.versions).toEqual([expect.objectContaining({
			number: 1,
			state: "draft",
			planRevision: 7,
			definition: definition(),
		})]);
		expect(backend.graphs.get("plan")).toEqual(graph);
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
			expect(await graphs.create("plan", invalid)).toEqual({ ok: false, reason });
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

		expect(await graphs.create("plan", tooFew)).toEqual({ ok: false, reason: "acceptance" });
		expect(await graphs.create("plan", tooMany)).toEqual({ ok: false, reason: "acceptance" });
	});

	it("refuses malformed definition data instead of throwing at the persistence boundary", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 1);
		let graphs = new Graphs(backend);

		expect(await graphs.create("plan", { tasks: null } as unknown as Definition)).toEqual({
			ok: false,
			reason: "task",
		});
	});

	it("freezes an approved version and creates a new draft when it is edited", async () => {
		let backend = new Memory();
		backend.revisions.set("plan", 3);
		let graphs = new Graphs(backend);
		let created = await expectGraph(graphs.create("plan", definition()));
		let approved = await expectGraph(graphs.approve("plan"));

		expect(approved.versions[0]).toEqual({ ...created.versions[0], state: "approved" });
		let edited = await expectGraph(graphs.edit("plan", changed()));

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
		await expectGraph(graphs.create("plan", definition()));
		await expectGraph(graphs.approve("plan"));

		backend.revisions.set("plan", 6);
		expect(await graphs.start("plan")).toEqual({ ok: false, reason: "stale-plan" });

		let replacement = await expectGraph(graphs.edit("plan", changed()));
		expect(replacement.versions[1]).toMatchObject({ state: "draft", planRevision: 6 });
		await expectGraph(graphs.approve("plan"));
		let locked = await expectGraph(graphs.start("plan"));

		expect(locked.versions[1]).toMatchObject({ state: "locked", planRevision: 6 });
		expect(await graphs.edit("plan", definition())).toEqual({ ok: false, reason: "locked" });
	});
});
