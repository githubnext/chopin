/**
 * Durable implementation work belongs beside a plan, not inside its prose.
 *
 * The adapter owns document lookup and persistence. This model only decides
 * whether a graph is valid and which version may change at a given plan
 * revision, so a hosted backend can use the same rules as the local one.
 */

export type Task = {
	id: string;
	title: string;
	context: string;
	goal: string;
	acceptance: string[];
	dependsOn: string[];
};

export type Definition = {
	tasks: Task[];
};

export type State = "draft" | "approved" | "locked" | "superseded";

export type Version = {
	number: number;
	/** Changes whenever a draft definition changes. */
	revision: number;
	planRevision: number;
	state: State;
	definition: Definition;
};

export type Graph = {
	versions: Version[];
};

/** Durable ownership of the external session implementing one locked graph. */
export type Run = {
	id: string;
	user: string;
	client: { name: string; version: string };
	session: string;
	planRevision: number;
	graphRevision: number;
	repository: string;
	branch: string;
	commit: string;
	startedAt: string;
};

export type ClaimInput = {
	planRevision: number;
	graphRevision: number;
	run: Run;
};

export type ClaimResult =
	| { kind: "started"; graph: Graph; run: Run }
	| { kind: "active"; run: Run }
	| { kind: "refused"; reason: string };

export type GraphAdapter<Document> = {
	/** Runs the change against one current graph and plan revision. */
	transact(
		document: Document,
		change: (current: { graph: Graph | undefined; revision: number | undefined }) => Result<Graph>,
	): Promise<Result<Graph>>;
};

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export type Operation =
	| { op: "add"; task: Task }
	| { op: "replace"; id: string; task: Task }
	| { op: "reorder"; ids: string[] }
	| { op: "remove"; id: string };

export type Revision = {
	/** The plan revision returned by the planner's graph read. */
	planRevision: number;
	/** The current draft revision, or zero before a graph exists. */
	graphRevision: number;
	operations: Operation[];
};

type Validation = Exclude<Result<Definition>, { ok: true }>;

function copy<T>(value: T): T {
	return structuredClone(value);
}

function invalid(reason: string): Validation {
	return { ok: false, reason };
}

function text(value: string): boolean {
	return value.trim().length > 0;
}

/** Validate references before looking for cycles, for useful refusal reasons. */
export function validate(definition: unknown): Result<Definition> {
	if (
		!definition || typeof definition !== "object"
		|| !Array.isArray((definition as Definition).tasks)
	) {
		return invalid("task");
	}
	let valid = definition as Definition;
	let ids = new Set<string>();
	for (let task of valid.tasks) {
		if (
			!task || typeof task !== "object" || !Array.isArray(task.acceptance)
			|| !Array.isArray(task.dependsOn)
		) {
			return invalid("task");
		}
		if (
			typeof task.id !== "string" || typeof task.title !== "string"
			|| typeof task.context !== "string"
			|| typeof task.goal !== "string" || task.dependsOn.some(item => typeof item !== "string")
		) {
			return invalid("task");
		}
		if (!text(task.id) || !text(task.title) || !text(task.context) || !text(task.goal)) {
			return invalid("task");
		}
		if (ids.has(task.id)) return invalid("duplicate");
		ids.add(task.id);
		if (
			task.acceptance.length < 2 || task.acceptance.length > 8
			|| task.acceptance.some(criterion => typeof criterion !== "string" || !text(criterion))
		) return invalid("acceptance");
	}

	for (let task of valid.tasks) {
		for (let dependency of task.dependsOn) {
			if (!ids.has(dependency)) return invalid("missing");
			if (dependency === task.id) return invalid("self");
		}
	}
	let visiting = new Set<string>();
	let visited = new Set<string>();
	let tasks = new Map(valid.tasks.map(task => [task.id, task]));
	function visit(id: string): boolean {
		if (visiting.has(id)) return true;
		if (visited.has(id)) return false;
		visiting.add(id);
		let cycle = tasks.get(id)?.dependsOn.some(visit) ?? false;
		visiting.delete(id);
		visited.add(id);
		return cycle;
	}

	if (valid.tasks.some(task => visit(task.id))) return invalid("cycle");
	if (
		valid.tasks.length === 0 || !valid.tasks.some(task => task.dependsOn.length === 0)
	) {
		return invalid("root");
	}
	return { ok: true, value: copy(valid) };
}

function current(graph: Graph): Version | undefined {
	return graph.versions.at(-1);
}

function state(value: unknown): State | undefined {
	return value === "draft" || value === "approved" || value === "locked" || value === "superseded"
		? value
		: undefined;
}

function item(value: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let record = value as Record<string, unknown>;
	let found = Object.keys(record).sort();
	let expected = [...keys].sort();
	return found.length === expected.length && found.every((key, index) => key === expected[index])
		? record
		: undefined;
}

function definition(value: unknown): Definition | undefined {
	let stored = item(value, ["tasks"]);
	if (!stored || !Array.isArray(stored.tasks)) return undefined;
	let tasks: Task[] = [];
	for (let value of stored.tasks) {
		let task = item(value, ["acceptance", "context", "dependsOn", "goal", "id", "title"]);
		if (
			!task
			|| typeof task.id !== "string"
			|| typeof task.title !== "string"
			|| typeof task.context !== "string"
			|| typeof task.goal !== "string"
			|| !Array.isArray(task.acceptance)
			|| !Array.isArray(task.dependsOn)
			|| task.acceptance.some(value => typeof value !== "string")
			|| task.dependsOn.some(value => typeof value !== "string")
		) return undefined;
		tasks.push({
			id: task.id,
			title: task.title,
			context: task.context,
			goal: task.goal,
			acceptance: task.acceptance,
			dependsOn: task.dependsOn,
		});
	}
	let checked = validate({ tasks });
	return checked.ok ? checked.value : undefined;
}

function history(versions: Version[]): boolean {
	let latest = versions.at(-1);
	if (!latest || latest.state === "superseded") return false;
	if (
		versions.some((version, index) =>
			index > 0 && version.planRevision < versions[index - 1].planRevision
		)
	) {
		return false;
	}
	let prior = versions.slice(0, -1);
	if (latest.state === "draft") {
		return prior.every((version, index) =>
			version.state === "superseded"
			|| index === prior.length - 1 && version.state === "approved"
		);
	}
	return prior.every(version => version.state === "superseded");
}

function run(value: unknown): Run | undefined {
	let stored = item(value, [
		"branch",
		"client",
		"commit",
		"graphRevision",
		"id",
		"planRevision",
		"repository",
		"session",
		"startedAt",
		"user",
	]);
	let client = stored && item(stored.client, ["name", "version"]);
	let strings = stored && client && [
		stored.id,
		stored.user,
		stored.session,
		stored.repository,
		stored.branch,
		stored.commit,
		stored.startedAt,
		client.name,
		client.version,
	];
	if (
		!stored
		|| !client
		|| !strings
		|| strings.some(value => typeof value !== "string" || !value.trim())
		|| !Number.isSafeInteger(stored.planRevision)
		|| (stored.planRevision as number) < 0
		|| !Number.isSafeInteger(stored.graphRevision)
		|| (stored.graphRevision as number) < 1
	) return undefined;
	return {
		id: stored.id as string,
		user: stored.user as string,
		client: { name: client.name as string, version: client.version as string },
		session: stored.session as string,
		planRevision: stored.planRevision as number,
		graphRevision: stored.graphRevision as number,
		repository: stored.repository as string,
		branch: stored.branch as string,
		commit: stored.commit as string,
		startedAt: stored.startedAt as string,
	};
}

/** Restore a run only when it names this sidecar's locked graph and revision. */
export function restoreRun(
	value: unknown,
	graph: Graph | undefined,
	revision: number,
): Run | undefined {
	let restored = run(value);
	let version = graph?.versions.at(-1);
	if (
		!restored
		|| !version
		|| version.state !== "locked"
		|| version.planRevision !== revision
		|| restored.planRevision !== revision
		|| restored.graphRevision !== version.revision
	) return undefined;
	return copy(restored);
}

/** Restore a historical run against the graph version it originally claimed. */
export function restoreRunVersion(value: unknown, graph: Graph): Run | undefined {
	let restored = run(value);
	if (
		!restored
		|| !graph.versions.some(version =>
			version.planRevision === restored.planRevision
			&& version.revision === restored.graphRevision
		)
	) return undefined;
	return copy(restored);
}

/** Lock exactly one approved graph revision and record its owner atomically. */
export function claim(
	state: { graph: Graph | undefined; revision: number | undefined; execution: Run | undefined },
	input: ClaimInput,
): ClaimResult {
	if (state.execution) return { kind: "active", run: copy(state.execution) };
	if (state.revision !== input.planRevision) return { kind: "refused", reason: "stale-plan" };
	let graph = state.graph && copy(state.graph);
	let version = graph?.versions.at(-1);
	let owner = run(input.run);
	if (!graph || !version) return { kind: "refused", reason: "missing" };
	if (!owner) return { kind: "refused", reason: "run" };
	if (version.revision !== input.graphRevision) return { kind: "refused", reason: "stale-graph" };
	if (version.state !== "approved") return { kind: "refused", reason: "not-approved" };
	if (version.planRevision !== state.revision) return { kind: "refused", reason: "stale-plan" };
	if (owner.planRevision !== input.planRevision || owner.graphRevision !== input.graphRevision) {
		return { kind: "refused", reason: "run" };
	}

	graph.versions[graph.versions.length - 1] = { ...version, state: "locked" };
	return { kind: "started", graph, run: copy(owner) };
}

/** Apply a planner's whole graph batch before deciding whether it is valid. */
function revise(definition: Definition, operations: unknown[]): Result<Definition> {
	let next = copy(definition);
	for (let operation of operations) {
		if (!operation || typeof operation !== "object") return invalid("operation");
		let value = operation as Partial<Operation>;
		switch (value.op) {
			case "add":
				if (!value.task) return invalid("operation");
				next.tasks.push(value.task);
				break;
			case "replace": {
				if (typeof value.id !== "string" || !value.task) return invalid("operation");
				let index = next.tasks.findIndex(task => task.id === value.id);
				if (index < 0) return invalid("missing");
				next.tasks[index] = value.task;
				break;
			}
			case "remove": {
				if (typeof value.id !== "string") return invalid("operation");
				let index = next.tasks.findIndex(task => task.id === value.id);
				if (index < 0) return invalid("missing");
				next.tasks.splice(index, 1);
				break;
			}
			case "reorder": {
				if (!Array.isArray(value.ids) || value.ids.some(id => typeof id !== "string")) {
					return invalid("operation");
				}
				let tasks = new Map(next.tasks.map(task => [task.id, task]));
				if (
					value.ids.length !== next.tasks.length || new Set(value.ids).size !== value.ids.length
					|| value.ids.some(id => !tasks.has(id))
				) return invalid("reorder");
				next.tasks = value.ids.map(id => tasks.get(id)!);
				break;
			}
			default:
				return invalid("operation");
		}
	}
	return validate(next);
}

/** Read a graph back from a sidecar without trusting handwritten JSON. */
export function restore(value: unknown): Graph | undefined {
	let stored = item(value, ["versions"]);
	if (!stored || !Array.isArray(stored.versions) || stored.versions.length === 0) return undefined;
	let versions: Version[] = [];
	for (let [index, value] of stored.versions.entries()) {
		let version = item(value, ["definition", "number", "planRevision", "revision", "state"])
			?? item(value, ["definition", "number", "planRevision", "state"]);
		let checked = version && definition(version.definition);
		let number = version?.number;
		let revision = version?.revision ?? 1;
		let planRevision = version?.planRevision;
		let versionState = state(version?.state);
		if (
			!version
			|| typeof number !== "number"
			|| number !== index + 1
			|| typeof revision !== "number"
			|| !Number.isInteger(revision)
			|| revision < 1
			|| typeof planRevision !== "number"
			|| !Number.isInteger(planRevision)
			|| planRevision < 0
			|| !versionState
			|| !checked
		) return undefined;
		versions.push({
			number,
			revision,
			planRevision,
			state: versionState,
			definition: checked,
		});
	}
	return history(versions) ? { versions } : undefined;
}

/**
 * Mutations go through this service rather than directly to a snapshot. The
 * caller gives it an adapter so graph state remains a backend concern and
 * never becomes an MDX node.
 */
export class Graphs<Document> {
	#adapter: GraphAdapter<Document>;

	constructor(adapter: GraphAdapter<Document>) {
		this.#adapter = adapter;
	}

	async #transact(
		document: Document,
		change: (current: { graph: Graph | undefined; revision: number | undefined }) => Result<Graph>,
	): Promise<Result<Graph>> {
		let result = await this.#adapter.transact(document, current => {
			let next = change({
				graph: current.graph && copy(current.graph),
				revision: current.revision,
			});
			return next.ok ? { ok: true, value: copy(next.value) } : next;
		});
		return result.ok ? { ok: true, value: copy(result.value) } : result;
	}

	/** Change a graph by operations from one particular planner read. */
	async revise(document: Document, change: Revision): Promise<Result<Graph>> {
		return await this.#transact(document, ({ graph, revision }) => {
			if (revision !== change.planRevision) return { ok: false, reason: "stale-plan" };
			let version = graph && current(graph);
			if ((version?.revision ?? 0) !== change.graphRevision) {
				return { ok: false, reason: "stale-graph" };
			}
			if (version?.state === "locked") return { ok: false, reason: "locked" };
			if (version?.state === "superseded") return { ok: false, reason: "superseded" };
			if (change.operations.length === 0) return { ok: false, reason: "operation" };

			let checked = revise(version?.definition ?? { tasks: [] }, change.operations);
			if (!checked.ok) return checked;
			if (!graph || !version) {
				return {
					ok: true,
					value: {
						versions: [{
							number: 1,
							revision: 1,
							planRevision: revision,
							state: "draft",
							definition: checked.value,
						}],
					},
				};
			}
			if (version.state === "draft") {
				graph.versions[graph.versions.length - 1] = {
					...version,
					revision: version.revision + 1,
					planRevision: revision,
					definition: checked.value,
				};
			} else {
				graph.versions.push({
					number: version.number + 1,
					revision: 1,
					planRevision: revision,
					state: "draft",
					definition: checked.value,
				});
			}
			return { ok: true, value: graph };
		});
	}

	async approve(document: Document): Promise<Result<Graph>> {
		return await this.#transact(document, ({ graph, revision }) => {
			let version = graph && current(graph);
			if (!graph || !version) return { ok: false, reason: "missing" };
			if (version.state !== "draft") return { ok: false, reason: "not-draft" };
			if (revision === undefined) return { ok: false, reason: "missing-document" };
			if (version.planRevision !== revision) return { ok: false, reason: "stale-plan" };
			let checked = validate(version.definition);
			if (!checked.ok) return checked;

			for (let prior of graph.versions) {
				if (prior.state === "approved") prior.state = "superseded";
			}
			graph.versions[graph.versions.length - 1] = {
				...graph.versions[graph.versions.length - 1],
				state: "approved",
				definition: checked.value,
			};
			return { ok: true, value: graph };
		});
	}

	async start(document: Document): Promise<Result<Graph>> {
		return await this.#transact(document, ({ graph, revision }) => {
			let version = graph && current(graph);
			if (!graph || !version) return { ok: false, reason: "missing" };
			if (version.state !== "approved") return { ok: false, reason: "not-approved" };
			if (revision === undefined) return { ok: false, reason: "missing-document" };
			if (version.planRevision !== revision) return { ok: false, reason: "stale-plan" };

			graph.versions[graph.versions.length - 1] = {
				...graph.versions[graph.versions.length - 1],
				state: "locked",
			};
			return { ok: true, value: graph };
		});
	}
}
