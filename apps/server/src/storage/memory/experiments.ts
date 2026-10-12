import { investigationSchema } from "@chopin/experiment/records";
import type { Investigation } from "@chopin/experiment/records";
import { deterministicChannelId } from "../../channels/id";
import type { ExperimentStore, InvestigationChildInput } from "../experiments";
import type { ChannelRecord, CreateChannel, Lease } from "../model";
import { conflict, missing } from "../errors";

export class MemoryExperimentStore implements ExperimentStore {
	#records = new Map<string, Investigation>();
	constructor(
		private options: {
			exists: (id: string) => boolean;
			active: (id: string) => boolean;
			fence: (lease: Lease) => void;
			channel: (id: string) => ChannelRecord | undefined;
			createChannel: (input: CreateChannel) => ChannelRecord;
		},
	) {}
	async get(id: string) {
		let value = this.#records.get(id);
		return value && this.options.exists(value.documentId) ? structuredClone(value) : undefined;
	}
	async list(documentId: string) {
		if (!this.options.exists(documentId)) return [];
		return [...this.#records.values()].filter(value => value.documentId === documentId)
			.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(value => structuredClone(value));
	}
	async published(childId: string) {
		let value = [...this.#records.values()].find(item => item.childId === childId);
		return value && this.options.exists(value.documentId) ? structuredClone(value) : undefined;
	}
	referencesChannel(channelId: string): boolean {
		return [...this.#records.values()].some(value => value.childId === channelId);
	}
	async active() {
		return [...this.#records.values()].filter(value =>
			this.options.exists(value.documentId)
			&& ["queued", "running", "publishing"].includes(value.state)
		)
			.map(value => structuredClone(value));
	}
	async save(value: Investigation, expected: number | undefined, lease: Lease) {
		this.options.fence(lease);
		if (!this.options.exists(value.documentId)) throw missing("experiment document not found");
		if (
			!this.options.active(value.documentId)
			&& !["failed", "cancelled", "interrupted"].includes(value.state)
		) throw conflict("experiment document archived");
		let previous = this.#records.get(value.id);
		if (previous?.revision !== expected) return false;
		if (
			value.revision !== (expected === undefined ? 0 : expected + 1)
			|| previous && previous.documentId !== value.documentId
		) throw conflict("invalid experiment revision");
		this.#records.set(value.id, structuredClone(investigationSchema.parse(value)));
		return true;
	}
	async publish(
		value: Investigation,
		expected: number,
		child: InvestigationChildInput,
		lease: Lease,
	): Promise<Investigation | false> {
		if (value.revision !== expected + 1 || value.state !== "completed" || !value.result) {
			throw conflict("invalid experiment publication");
		}
		this.options.fence(lease);
		let channel = this.options.channel(value.documentId);
		if (!channel) throw missing("experiment document not found");
		let current = this.#records.get(value.id);
		if (!current || current.documentId !== value.documentId) throw missing("experiment not found");
		if (current.childId) return structuredClone(current);
		if (current.revision !== expected) return false;
		if (channel.archivedAt) throw conflict("experiment document archived");
		// A child document never holds investigations, so it never publishes one either.
		if (channel.parentChannelId) throw conflict("experiment document is a child");
		let saved = investigationSchema.parse({
			...value,
			childId: deterministicChannelId(channel.repositoryId, `investigation:${value.id}`),
		});
		this.options.createChannel({
			id: saved.childId!,
			repositoryId: channel.repositoryId,
			repositoryOwner: channel.repositoryOwner,
			repositoryName: channel.repositoryName,
			parentChannelId: value.documentId,
			title: child.title,
			createdBy: value.requester,
			now: child.now,
			initial: child.initial,
		});
		this.#records.set(saved.id, structuredClone(saved));
		return saved;
	}
}
