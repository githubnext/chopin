import type { SQL } from "bun";
import type {
	DocumentVersion,
	RecordDocumentVersion,
	StoredDocumentVersion,
	SummarizeDocumentVersion,
} from "../model";
import type { DocumentVersionStore } from "../port";

type VersionRow = {
	id: string;
	channelId: string;
	authorId: string | null;
	authorLogin: string | null;
	authorAvatarUrl: string | null;
	revision: number;
	sourceHash: string;
	startedAt: Date | string;
	updatedAt: Date | string;
	summary: string | null;
	source?: string;
};

function version(row: VersionRow): DocumentVersion {
	return {
		id: row.id,
		channelId: row.channelId,
		...(row.authorId ? { authorId: row.authorId } : {}),
		...(row.authorLogin ? { authorLogin: row.authorLogin } : {}),
		...(row.authorAvatarUrl ? { authorAvatarUrl: row.authorAvatarUrl } : {}),
		revision: Number(row.revision),
		sourceHash: row.sourceHash,
		startedAt: new Date(row.startedAt),
		updatedAt: new Date(row.updatedAt),
		...(row.summary ? { summary: row.summary } : {}),
	};
}

// A summary counts only while it describes the session's current source (summary_hash).

export class PostgresDocumentVersionStore implements DocumentVersionStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	record(input: RecordDocumentVersion) {
		return this.run("record document version", () =>
			this.sql.begin(async transaction => {
				// Sessions are decided from the latest row, so two recorders for one document take turns.
				await transaction`
					SELECT pg_advisory_xact_lock(hashtext(${`document_versions:${input.channelId}`}))
				`;
				let [latest] = await transaction<
					{ id: string; authorId: string | null; sourceHash: string; updatedAt: Date | string }[]
				>`
					SELECT id, author_id AS "authorId", source_hash AS "sourceHash",
						updated_at AS "updatedAt"
					FROM document_versions
					WHERE channel_id = ${input.channelId}
					ORDER BY updated_at DESC, id DESC
					LIMIT 1
				`;
				if (latest?.sourceHash === input.sourceHash) return undefined;
				let authorId = input.authorId ?? null;
				let continues = latest
					&& !input.newSession
					&& latest.authorId === authorId
					&& input.now.getTime() - new Date(latest.updatedAt).getTime() <= input.idleMs;
				let id = continues ? latest.id : crypto.randomUUID();
				if (continues) {
					await transaction`
						UPDATE document_versions
						SET revision = ${input.revision}, source = ${input.source},
							source_hash = ${input.sourceHash},
							updated_at = GREATEST(updated_at, ${input.now})
						WHERE id = ${id}
					`;
				} else {
					await transaction`
						INSERT INTO document_versions (
							id, channel_id, author_id, revision, source, source_hash, started_at, updated_at
						) VALUES (
							${id}, ${input.channelId}, ${authorId}, ${input.revision}, ${input.source},
							${input.sourceHash}, ${input.now}, ${input.now}
						)
					`;
				}
				let [row] = await transaction<VersionRow[]>`
					SELECT v.id, v.channel_id AS "channelId", v.author_id AS "authorId",
					u.login AS "authorLogin", u.avatar_url AS "authorAvatarUrl", v.revision,
					v.source_hash AS "sourceHash", v.started_at AS "startedAt", v.updated_at AS "updatedAt",
					CASE WHEN v.summary_hash = v.source_hash THEN v.summary END AS summary
					FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
					WHERE v.id = ${id}
				`;
				return version(row!);
			}));
	}
	list(channelId: string, limit: number) {
		return this.run("list document versions", async () => {
			let rows = await this.sql<VersionRow[]>`
				SELECT v.id, v.channel_id AS "channelId", v.author_id AS "authorId",
					u.login AS "authorLogin", u.avatar_url AS "authorAvatarUrl", v.revision,
					v.source_hash AS "sourceHash", v.started_at AS "startedAt", v.updated_at AS "updatedAt",
					CASE WHEN v.summary_hash = v.source_hash THEN v.summary END AS summary
				FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
				WHERE v.channel_id = ${channelId}
				ORDER BY v.updated_at DESC, v.id DESC
				LIMIT ${limit}
			`;
			return rows.map(version);
		});
	}
	get(channelId: string, id: string) {
		return this.run("read document version", async () => {
			let [row] = await this.sql<VersionRow[]>`
				SELECT v.id, v.channel_id AS "channelId", v.author_id AS "authorId",
					u.login AS "authorLogin", u.avatar_url AS "authorAvatarUrl", v.revision,
					v.source_hash AS "sourceHash", v.started_at AS "startedAt", v.updated_at AS "updatedAt",
					CASE WHEN v.summary_hash = v.source_hash THEN v.summary END AS summary, v.source
				FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
				WHERE v.channel_id = ${channelId} AND v.id = ${id}
			`;
			return row
				? { ...version(row), source: row.source! } satisfies StoredDocumentVersion
				: undefined;
		});
	}
	previous(channelId: string, id: string) {
		return this.run("read previous document version", async () => {
			let [row] = await this.sql<VersionRow[]>`
				SELECT v.id, v.channel_id AS "channelId", v.author_id AS "authorId",
					u.login AS "authorLogin", u.avatar_url AS "authorAvatarUrl", v.revision,
					v.source_hash AS "sourceHash", v.started_at AS "startedAt", v.updated_at AS "updatedAt",
					CASE WHEN v.summary_hash = v.source_hash THEN v.summary END AS summary, v.source
				FROM document_versions v
				LEFT JOIN users u ON u.id = v.author_id
				JOIN document_versions anchor ON anchor.id = ${id} AND anchor.channel_id = ${channelId}
				WHERE v.channel_id = ${channelId}
					AND (v.updated_at, v.id) < (anchor.updated_at, anchor.id)
				ORDER BY v.updated_at DESC, v.id DESC
				LIMIT 1
			`;
			return row
				? { ...version(row), source: row.source! } satisfies StoredDocumentVersion
				: undefined;
		});
	}
	summarize(input: SummarizeDocumentVersion) {
		return this.run("summarize document version", async () => {
			let rows = await this.sql`
				UPDATE document_versions
				SET summary = ${input.summary}, summary_hash = ${input.sourceHash}
				WHERE channel_id = ${input.channelId} AND id = ${input.id}
					AND source_hash = ${input.sourceHash}
				RETURNING id
			`;
			return rows.length > 0;
		});
	}
}
