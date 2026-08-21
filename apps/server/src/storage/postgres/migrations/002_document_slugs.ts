import type { TransactionSQL } from "bun";

const MAX_SLUG_LENGTH = 100;
const BATCH_SIZE = 500;

type Channel = {
	id: string;
	repositoryId: string;
	title: string;
	createdAt: Date | string;
};

function truncated(value: string, maximum: number): string {
	return Array.from(value).slice(0, maximum).join("").replace(/-+$/u, "");
}

function slug(title: string): string {
	let value = title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return value ? truncated(value, MAX_SLUG_LENGTH) : "document";
}

function candidate(base: string, index: number): string {
	if (index === 1) return base;
	let suffix = `-${index}`;
	return `${truncated(base, MAX_SLUG_LENGTH - Array.from(suffix).length)}${suffix}`;
}

async function page(sql: TransactionSQL, after?: Channel): Promise<Channel[]> {
	let columns = sql.unsafe(`
		channels.id,
		channels.repository_id AS "repositoryId",
		channels.title,
		channels.created_at AS "createdAt"
	`);
	return after
		? sql<Channel[]>`
			SELECT ${columns}
			FROM channels
			WHERE (channels.repository_id, channels.created_at, channels.id) > (
				${after.repositoryId}, ${after.createdAt}, ${after.id}
			)
				AND NOT EXISTS (
					SELECT 1 FROM channel_slugs
					WHERE channel_slugs.channel_id = channels.id AND channel_slugs.canonical
				)
			ORDER BY channels.repository_id, channels.created_at, channels.id
			LIMIT ${BATCH_SIZE}
			FOR UPDATE
		`
		: sql<Channel[]>`
			SELECT ${columns}
			FROM channels
			WHERE NOT EXISTS (
				SELECT 1 FROM channel_slugs
				WHERE channel_slugs.channel_id = channels.id AND channel_slugs.canonical
			)
			ORDER BY channels.repository_id, channels.created_at, channels.id
			LIMIT ${BATCH_SIZE}
			FOR UPDATE
		`;
}

/** Immutable data migration paired with 002_document_slugs.sql. */
export async function backfillDocumentSlugs(sql: TransactionSQL): Promise<void> {
	let occupied = new Set<string>();
	let next = new Map<string, number>();
	let repositoryId: string | undefined;
	let after: Channel | undefined;
	while (true) {
		let channels = await page(sql, after);
		if (channels.length === 0) return;
		for (let channel of channels) {
			if (channel.repositoryId !== repositoryId) {
				repositoryId = channel.repositoryId;
				occupied.clear();
				next.clear();
			}
			let base = slug(channel.title);
			let baseKey = `${channel.repositoryId}\0${base}`;
			let index = next.get(baseKey) ?? 1;
			while (true) {
				let value = candidate(base, index);
				let key = `${channel.repositoryId}\0${value}`;
				index++;
				if (occupied.has(key)) continue;
				let [inserted] = await sql<{ slug: string }[]>`
					INSERT INTO channel_slugs (
						repository_id, slug, channel_id, canonical, created_at
					) VALUES (
						${channel.repositoryId}, ${value}, ${channel.id}, true, ${channel.createdAt}
					)
					ON CONFLICT DO NOTHING
					RETURNING slug
				`;
				occupied.add(key);
				if (!inserted) continue;
				next.set(baseKey, index);
				break;
			}
		}
		after = channels.at(-1);
	}
}
