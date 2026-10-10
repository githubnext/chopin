import type { SQL } from "bun";
import type { PutImage, StoredImage } from "../model";
import type { ImageStore } from "../port";

type ImageRow = {
	channelId: string;
	sha256: string;
	mimeType: string;
	bytes: Uint8Array;
	size: number;
	uploadedBy: string;
	createdAt: Date | string;
};

export class PostgresImageStore implements ImageStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	put(input: PutImage) {
		return this.run("save image", async () => {
			await this.sql`
				INSERT INTO plan_images (sha256, channel_id, mime_type, bytes, size, uploaded_by, created_at)
				VALUES (
					${input.sha256}, ${input.channelId}, ${input.mimeType}, ${input.bytes},
					${input.bytes.byteLength}, ${input.uploadedBy}, ${input.now}
				)
				ON CONFLICT (channel_id, sha256) DO NOTHING
			`;
		});
	}
	get(channelId: string, sha256: string) {
		return this.run("read image", async () => {
			let [row] = await this.sql<ImageRow[]>`
				SELECT channel_id AS "channelId", sha256, mime_type AS "mimeType", bytes, size,
					uploaded_by AS "uploadedBy", created_at AS "createdAt"
				FROM plan_images
				WHERE channel_id = ${channelId} AND sha256 = ${sha256}
			`;
			return row
				? {
					...row,
					bytes: new Uint8Array(row.bytes),
					createdAt: new Date(row.createdAt),
				} satisfies StoredImage
				: undefined;
		});
	}
	channels(sha256: string) {
		return this.run("find image documents", async () => {
			let rows = await this.sql<{ channelId: string }[]>`
				SELECT channel_id AS "channelId" FROM plan_images
				WHERE sha256 = ${sha256}
				ORDER BY created_at, channel_id
			`;
			return rows.map(row => row.channelId);
		});
	}
}
