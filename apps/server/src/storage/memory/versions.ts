import { missing } from "../errors";

import type {
	DocumentVersion,
	RecordDocumentVersion,
	StoredDocumentVersion,
	SummarizeDocumentVersion,
	UserRecord,
} from "../model";
import type { DocumentVersionStore } from "../port";

type Row = Omit<StoredDocumentVersion, "authorLogin" | "authorAvatarUrl" | "summary"> & {
	summary?: { text: string; sourceHash: string };
};

export class MemoryDocumentVersionStore implements DocumentVersionStore {
	#versions = new Map<string, Row[]>();
	constructor(
		private options: {
			channelExists: (id: string) => boolean;
			user: (id: string) => UserRecord | undefined;
		},
	) {}
	#public(row: Row): DocumentVersion {
		let { source: _source, summary, ...value } = row;
		let author = row.authorId ? this.options.user(row.authorId) : undefined;
		return {
			...value,
			...(summary?.sourceHash === row.sourceHash ? { summary: summary.text } : {}),
			...(author?.login ? { authorLogin: author.login } : {}),
			...(author?.avatarUrl ? { authorAvatarUrl: author.avatarUrl } : {}),
			startedAt: new Date(row.startedAt),
			updatedAt: new Date(row.updatedAt),
		};
	}
	async record(input: RecordDocumentVersion) {
		if (!this.options.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (input.authorId && !this.options.user(input.authorId)) {
			throw missing(`user ${input.authorId} does not exist`);
		}
		let rows = this.#versions.get(input.channelId) ?? [];
		let latest = rows.at(-1);
		if (latest?.sourceHash === input.sourceHash) return undefined;
		let continued = latest
				&& !input.newSession
				&& latest.authorId === input.authorId
				&& input.now.getTime() - latest.updatedAt.getTime() <= input.idleMs
			? latest
			: undefined;
		let row: Row = continued
			? {
				...continued,
				revision: input.revision,
				source: input.source,
				sourceHash: input.sourceHash,
				updatedAt: new Date(Math.max(continued.updatedAt.getTime(), input.now.getTime())),
			}
			: {
				id: crypto.randomUUID(),
				channelId: input.channelId,
				...(input.authorId ? { authorId: input.authorId } : {}),
				revision: input.revision,
				source: input.source,
				sourceHash: input.sourceHash,
				startedAt: new Date(input.now),
				updatedAt: new Date(input.now),
			};
		this.#versions.set(input.channelId, continued ? [...rows.slice(0, -1), row] : [...rows, row]);
		return this.#public(row);
	}
	async list(channelId: string, limit: number) {
		return (this.#versions.get(channelId) ?? []).slice(-limit).toReversed().map(row =>
			this.#public(row)
		);
	}
	async get(channelId: string, id: string) {
		let row = this.#versions.get(channelId)?.find(item => item.id === id);
		return row && { ...this.#public(row), source: row.source };
	}
	async previous(channelId: string, id: string) {
		let rows = this.#versions.get(channelId) ?? [];
		let index = rows.findIndex(item => item.id === id);
		let row = index > 0 ? rows[index - 1] : undefined;
		return row && { ...this.#public(row), source: row.source };
	}
	async summarize(input: SummarizeDocumentVersion) {
		let rows = this.#versions.get(input.channelId) ?? [];
		let index = rows.findIndex(item => item.id === input.id);
		let row = rows[index];
		if (!row || row.sourceHash !== input.sourceHash) return false;
		rows[index] = { ...row, summary: { text: input.summary, sourceHash: input.sourceHash } };
		return true;
	}
	deleteChannel(channelId: string) {
		this.#versions.delete(channelId);
	}
}
