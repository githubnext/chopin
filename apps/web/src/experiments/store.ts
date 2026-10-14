import type {
	InvestigationChild,
	InvestigationSummary,
	PublishedInvestigation,
} from "@chopin/experiment/records";
import { experimentRequest } from "./api";
import type { Wire } from "../wire";
import type { SelectionPatch } from "@chopin/experiment";
import type { Followthrough } from "@chopin/protocol";
import { updateFollowthrough } from "../followthrough";

export class ExperimentStore {
	#listeners = new Set<() => void>();
	#version = 0;
	#controller = new AbortController();
	#request = 0;
	#details = new Map<string, number>();
	#mutations = new Set<string>();
	items: InvestigationSummary[] = [];
	values = new Map<string, PublishedInvestigation>();
	error = "";
	#published = new Set<string>();
	constructor(
		readonly documentId: string,
		private onPublished: (child: InvestigationChild) => void = () => {},
	) {}
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
	mutating(id: string) {
		return this.#mutations.has(id);
	}
	async refresh(reloadDetails = false) {
		let request = ++this.#request;
		let controller = this.#controller;
		try {
			let result = await experimentRequest<{ experiments: InvestigationSummary[] }>(
				`/api/documents/${this.documentId}/experiments`,
				undefined,
				this.#controller.signal,
			);
			if (request !== this.#request) return;
			this.items = result.experiments;
			this.error = "";
			this.changed();
			for (let item of result.experiments) {
				if (item.decisionCount && !this.values.has(item.id)) void this.load(item.id);
			}
			for (let [id, value] of this.values) {
				if (
					reloadDetails
					|| result.experiments.find(item => item.id === id)?.revision !== value.revision
				) {
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
			if (
				this.#details.get(id) !== sequence
				|| controller !== this.#controller || controller.signal.aborted
			) return;
			this.#accept(value);
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
		this.#accept(value);
		void this.refresh();
		return value;
	}
	async review(id: string, action: Followthrough.Action) {
		let current = this.values.get(id);
		if (!current?.followthrough) throw new Error("This investigation has no review to update.");
		if (this.#mutations.has(id)) return;
		this.#mutations.add(id);
		this.changed();
		try {
			let view = await updateFollowthrough(this.documentId, current.followthrough, action);
			if (view.id !== current.followthrough.id) throw new Error("Review response did not match.");
			this.#details.set(id, (this.#details.get(id) ?? 0) + 1);
			this.#accept({ ...(this.values.get(id) ?? current), followthrough: view });
			await this.load(id);
		} finally {
			this.#mutations.delete(id);
			this.changed();
		}
	}
	#accept(value: PublishedInvestigation) {
		let current = this.values.get(value.id);
		if (current && value.revision < current.revision) return this.changed();
		let previous = current?.followthrough;
		if (
			previous && current?.generation === value.generation && current.child?.id === value.child?.id
			&& (!value.followthrough
				|| value.followthrough.id === previous.id
					&& value.followthrough.revision < previous.revision)
		) value = { ...value, followthrough: previous };
		this.values.set(value.id, value);
		// Navigation learns of a child only when this session watched it arrive.
		if (current && !current.child && value.child && !this.#published.has(value.id)) {
			this.#published.add(value.id);
			this.onPublished(value.child);
		}
		this.changed();
	}
	connect(wire?: Wire) {
		this.#controller = new AbortController();
		// Review receipts advance independently of an investigation's own revision.
		let off = wire?.on("experiment:changed", () => void this.refresh(true));
		void this.refresh(true);
		let timer = setInterval(() => void this.refresh(), 20_000);
		return () => {
			off?.();
			clearInterval(timer);
			this.#controller.abort();
		};
	}
	async change(id: string, view: string, patch: SelectionPatch) {
		try {
			await this.action(id, "state", { view, patch });
		} finally {
			await this.load(id);
		}
	}
	async place(id: string, view: string, decision?: string, remove = false) {
		await this.action(id, "placement", { view, ...(decision ? { decision } : {}), remove });
	}
}
