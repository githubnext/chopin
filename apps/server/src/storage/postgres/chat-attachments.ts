import type { SQL } from "bun";
import type { PutChatAttachment, StoredChatAttachment } from "../model";
import type { ChatAttachmentStore } from "../port";

type AttachmentRow = {
	id: string;
	channelId: string;
	name: string;
	kind: "image" | "file";
	mimeType: string;
	bytes: Uint8Array;
	size: number;
	uploadedBy: string;
	createdAt: Date | string;
	entryId: string | null;
	position: number | null;
};

/** Raised inside a transaction to roll it back when the files cannot all be sent. */
class Refused extends Error {}

function stored(row: AttachmentRow): StoredChatAttachment {
	let { entryId, position, ...rest } = row;
	return {
		...rest,
		bytes: new Uint8Array(row.bytes),
		createdAt: new Date(row.createdAt),
		...(entryId !== null ? { entryId } : {}),
		...(position !== null ? { position } : {}),
	};
}

export class PostgresChatAttachmentStore implements ChatAttachmentStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	put(input: PutChatAttachment) {
		return this.run("save chat attachment", async () => {
			await this.sql`
				INSERT INTO chat_attachments
					(id, channel_id, name, kind, mime_type, bytes, size, uploaded_by, created_at)
				VALUES (
					${input.id}, ${input.channelId}, ${input.name}, ${input.kind}, ${input.mimeType},
					${input.bytes}, ${input.bytes.byteLength}, ${input.uploadedBy}, ${input.now}
				)
				ON CONFLICT (id) DO NOTHING
			`;
		});
	}
	get(channelId: string, id: string) {
		return this.run("read chat attachment", async () => {
			let [row] = await this.sql<AttachmentRow[]>`
				SELECT id, channel_id AS "channelId", name, kind, mime_type AS "mimeType", bytes, size,
					uploaded_by AS "uploadedBy", created_at AS "createdAt", entry_id AS "entryId", position
				FROM chat_attachments
				WHERE channel_id = ${channelId} AND id = ${id}
			`;
			return row ? stored(row) : undefined;
		});
	}
	staged(channelId: string, userId: string) {
		return this.run("count staged chat attachments", async () => {
			let [row] = await this.sql<{ count: number; bytes: number }[]>`
				SELECT count(*)::int AS count, coalesce(sum(size), 0)::bigint::float8 AS bytes
				FROM chat_attachments
				WHERE channel_id = ${channelId} AND uploaded_by = ${userId} AND entry_id IS NULL
			`;
			return { count: Number(row!.count), bytes: Number(row!.bytes) };
		});
	}
	bind(input: { channelId: string; userId: string; ids: string[]; entryId: string }) {
		return this.run("send chat attachments", async () => {
			if (new Set(input.ids).size !== input.ids.length) return false;
			if (input.ids.length === 0) return true;
			try {
				await this.sql.begin(async transaction => {
					let rows = await transaction<{ id: string }[]>`
						UPDATE chat_attachments
						SET entry_id = ${input.entryId},
							position = array_position(${input.ids}::text[], id) - 1
						WHERE channel_id = ${input.channelId} AND uploaded_by = ${input.userId}
							AND id = ANY(${input.ids}::text[])
							AND (entry_id IS NULL OR entry_id = ${input.entryId})
						RETURNING id
					`;
					if (rows.length !== input.ids.length) throw new Refused();
				});
				return true;
			} catch (error) {
				if (error instanceof Refused) return false;
				throw error;
			}
		});
	}
	forEntry(channelId: string, entryId: string) {
		return this.run("read a message's chat attachments", async () => {
			let rows = await this.sql<AttachmentRow[]>`
				SELECT id, channel_id AS "channelId", name, kind, mime_type AS "mimeType", bytes, size,
					uploaded_by AS "uploadedBy", created_at AS "createdAt", entry_id AS "entryId", position
				FROM chat_attachments
				WHERE channel_id = ${channelId} AND entry_id = ${entryId}
				ORDER BY position
			`;
			return rows.map(stored);
		});
	}
	discard(channelId: string, id: string, userId: string) {
		return this.run("discard a chat attachment", async () => {
			let rows = await this.sql<{ id: string }[]>`
				DELETE FROM chat_attachments
				WHERE channel_id = ${channelId} AND id = ${id} AND uploaded_by = ${userId}
					AND entry_id IS NULL
				RETURNING id
			`;
			return rows.length === 1;
		});
	}
	discardEntry(channelId: string, entryId: string) {
		return this.run("discard a message's chat attachments", async () => {
			let rows = await this.sql<{ id: string }[]>`
				DELETE FROM chat_attachments WHERE channel_id = ${channelId} AND entry_id = ${entryId}
				RETURNING id
			`;
			return rows.length;
		});
	}
	prune(before: Date) {
		return this.run("forget unsent chat attachments", async () => {
			let rows = await this.sql<{ id: string }[]>`
				DELETE FROM chat_attachments WHERE entry_id IS NULL AND created_at < ${before}
				RETURNING id
			`;
			return rows.length;
		});
	}
}
