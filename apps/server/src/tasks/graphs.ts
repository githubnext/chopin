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

/** Read a graph back from a sidecar without trusting handwritten JSON. */
export function restore(value: unknown): Graph | undefined {
	if (!value || typeof value !== "object" || !Array.isArray((value as Graph).versions)) {
		return undefined;
	}
	let graph = value as Graph;
	if (graph.versions.length === 0) return undefined;
	for (let [index, version] of graph.versions.entries()) {
		if (
			!version || typeof version !== "object" || version.number !== index + 1
			|| !Number.isInteger(version.planRevision) || version.planRevision < 0
			|| !["draft", "approved", "locked", "superseded"].includes(version.state)
			|| !validate(version.definition).ok
		) return undefined;
	}
	return copy(graph);
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
					planRevision: revision,
					definition: checked.value,
				};
			} else {
				graph.versions.push({
					number: version.number + 1,
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
