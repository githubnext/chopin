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

export type GraphAdapter<Document> = {
	/** Runs the change against one current graph and plan revision. */
	transact(
		document: Document,
		change: (current: { graph: Graph | undefined; revision: number | undefined }) => Result<Graph>,
	): Promise<Result<Graph>>;
};

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

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

/** Read a graph back from a sidecar without trusting handwritten JSON. */
export function restore(value: unknown): Graph | undefined {
	let stored = item(value, ["versions"]);
	if (!stored || !Array.isArray(stored.versions) || stored.versions.length === 0) return undefined;
	let versions: Version[] = [];
	for (let [index, value] of stored.versions.entries()) {
		let version = item(value, ["definition", "number", "planRevision", "revision", "state"])
			?? item(value, ["definition", "number", "planRevision", "state"]);
		let checked = version && definition(version.definition);
		if (
			!version
			|| version.number !== index + 1
			|| !Number.isInteger(version.revision ?? 1)
			|| (version.revision ?? 1) < 1
			|| !Number.isInteger(version.planRevision)
			|| version.planRevision < 0
			|| !["draft", "approved", "locked", "superseded"].includes(version.state as string)
			|| !checked
		) return undefined;
		versions.push({
			number: version.number,
			revision: version.revision ?? 1,
			planRevision: version.planRevision,
			state: version.state as State,
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

	async create(document: Document, definition: Definition): Promise<Result<Graph>> {
		return await this.#transact(document, ({ graph, revision }) => {
			if (graph) return { ok: false, reason: "exists" };
			if (revision === undefined) return { ok: false, reason: "missing-document" };
			let checked = validate(definition);
			if (!checked.ok) return checked;
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
		});
	}

	async edit(document: Document, definition: Definition): Promise<Result<Graph>> {
		return await this.#transact(document, ({ graph, revision }) => {
			let version = graph && current(graph);
			if (!graph || !version) return { ok: false, reason: "missing" };
			if (version.state === "locked") return { ok: false, reason: "locked" };
			if (version.state === "superseded") return { ok: false, reason: "superseded" };
			if (revision === undefined) return { ok: false, reason: "missing-document" };
			let checked = validate(definition);
			if (!checked.ok) return checked;

			if (version.state === "draft") {
				graph.versions[graph.versions.length - 1] = {
					...graph.versions[graph.versions.length - 1],
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
