import type {
	InvestigationSummary,
	PublishedInvestigation,
	WorkspaceConnection,
} from "@chopin/experiment/records";
import { experimentRequest } from "./api";
import type { Wire } from "../wire";

export class ExperimentStore {
	#listeners = new Set<() => void>();
	#version = 0;
	#controller = new AbortController();
	#request = 0;
	#details = new Map<string, number>();
	items: InvestigationSummary[] = [];
	connections: WorkspaceConnection[] = [];
	values = new Map<string, PublishedInvestigation>();
	error = "";
	constructor(readonly documentId: string) {}
	readonly snapshot = () => this.#version;
	readonly subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	changed() {
		this.#version++;
		for (let listener of this.#listeners) listener();
	}
	get(id: string) {
		return this.values.get(id);
	}
	async refresh() {
		let request = ++this.#request;
		let controller = this.#controller;
		try {
			let result = await experimentRequest<
				{ experiments: InvestigationSummary[]; connections: WorkspaceConnection[] }
			>(`/api/documents/${this.documentId}/experiments`, undefined, this.#controller.signal);
			if (request !== this.#request) return;
			this.items = result.experiments;
			this.connections = result.connections;
			this.error = "";
			this.changed();
			for (let [id, value] of this.values) {
				if (result.experiments.find(item => item.id === id)?.revision !== value.revision) {
					void this.load(id);
				}
			}
		} catch (error) {
			if (
				controller === this.#controller && !controller.signal.aborted && request === this.#request
			) {
				this.error = String((error as Error).message);
				this.changed();
			}
		}
	}
	async load(id: string) {
		let controller = this.#controller;
		let sequence = (this.#details.get(id) ?? 0) + 1;
		this.#details.set(id, sequence);
		try {
			let value = await experimentRequest<PublishedInvestigation>(
				`/api/documents/${this.documentId}/experiments/${id}`,
				undefined,
				this.#controller.signal,
			);
			if (this.#details.get(id) !== sequence) return;
			let current = this.values.get(id);
			if (!current || value.revision >= current.revision) this.values.set(id, value);
			this.changed();
		} catch (error) {
			if (controller === this.#controller && !controller.signal.aborted) {
				this.error = String((error as Error).message);
				this.changed();
			}
		}
	}
	async action(id: string, action: string, body: unknown) {
		let value = await experimentRequest<PublishedInvestigation>(
			`/api/documents/${this.documentId}/experiments${id ? `/${id}` : ""}${
				action ? `/${action}` : ""
			}`,
			body,
		);
		let current = this.values.get(value.id);
		if (!current || value.revision >= current.revision) this.values.set(value.id, value);
		this.changed();
		void this.refresh();
		return value;
	}
	connect(wire?: Wire) {
		this.#controller = new AbortController();
		let off = wire?.on("experiment:changed", () => void this.refresh());
		void this.refresh();
		let timer = setInterval(() => void this.refresh(), 20_000);
		return () => {
			off?.();
			clearInterval(timer);
			this.#controller.abort();
		};
	}
}
