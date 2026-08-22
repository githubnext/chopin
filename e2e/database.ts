import { createHash } from "node:crypto";
import { SQL } from "bun";
import { storedDocument, storedLegacyCallout } from "../apps/server/src/testing/plan";

import type { SeedState } from "../apps/server/src/testing/plan";

const DEFAULT_DATABASES: Record<number, string> = {
	8788: "postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	8789: "postgresql://chopin:chopin@127.0.0.1:5434/chopin?sslmode=disable",
};

export function testChannelSlug(id: string): string {
	return `test-${id.slice(0, 8)}`;
}

export function testChannelPath(id: string): string {
	return `/documents/octo-org/score/${testChannelSlug(id)}`;
}

function url(port: number): string {
	let index = port === 8789 ? 1 : 0;
	return process.env[`E2E_DATABASE_URL_${index}`] || DEFAULT_DATABASES[port]!;
}

async function sql<T>(port: number, action: (database: SQL) => Promise<T>): Promise<T> {
	let database = new SQL(url(port));
	try {
		return await action(database);
	} finally {
		await database.close();
	}
}

export async function createChannel(port: number, id: string): Promise<void> {
	await sql(port, async database => {
		let now = new Date();
		let slug = testChannelSlug(id);
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO users (id, login, avatar_url, created_at, updated_at)
				VALUES ('U_e2e', 'e2e', '', ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`;
			await transaction`
				INSERT INTO channels (
					id, repository_id, repository_owner, repository_name, title,
					created_by, revision, next_sequence, created_at, updated_at
				) VALUES (
					${id}, 'R_score', 'octo-org', 'score', ${`Test ${id.slice(0, 8)}`},
					'U_e2e', 0, 1, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO channel_slugs (
					repository_id, slug, channel_id, canonical, created_at
				) VALUES ('R_score', ${slug}, ${id}, true, ${now})
			`;
			await transaction`
				INSERT INTO channel_state (channel_id, sidecar) VALUES (${id}, 'null'::jsonb)
			`;
		});
	});
}

export async function seedChannel(
	port: number,
	id: string,
	source: string,
	state: SeedState = {},
): Promise<void> {
	return seed(port, id, source, state, storedDocument);
}

export async function seedLegacyCalloutChannel(
	port: number,
	id: string,
	source: string,
): Promise<void> {
	return seed(port, id, source, {}, storedLegacyCallout);
}

async function seed(
	port: number,
	id: string,
	source: string,
	state: SeedState,
	encode: typeof storedDocument,
): Promise<void> {
	let document = await encode(source);
	let sidecar = {
		version: 1,
		revision: state.revision ?? 0,
		documentSeq: 0,
		questions: state.questions ?? [],
		openQuestions: state.openQuestions ?? [],
		threads: state.threads ?? [],
		transcript: state.transcript ?? [],
	};
	await sql(port, async database => {
		await database`
				INSERT INTO channel_snapshots (
					channel_id, generation, revision, through_sequence, epoch, source,
					source_hash, document, sidecar, created_at
				) VALUES (
					${id}, ${crypto.randomUUID()}, 0, 0, ${document.epoch}, ${document.source},
					${`sha256:${createHash("sha256").update(document.source).digest("hex")}`},
					${document.update}, ${JSON.stringify(sidecar)}::jsonb, ${new Date()}
				)
			`;
	});
}

export async function readSource(port: number, id: string): Promise<string> {
	return sql(port, async database => {
		let [row] = await database<{ source: string }[]>`
			SELECT source FROM channel_snapshots WHERE channel_id = ${id}
		`;
		return row?.source ?? "";
	});
}

export async function seedCompletedResearchJob(
	port: number,
	channelId: string,
	questionId: string,
	question: string,
): Promise<void> {
	let now = new Date();
	let jobId = crypto.randomUUID();
	let targetKey = `research-question:${questionId}`;
	await sql(port, async database => {
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO background_job_channels (channel_id, revision) VALUES (${channelId}, 1)
			`;
			await transaction`
				INSERT INTO background_job_targets (channel_id, target_key, generation)
				VALUES (${channelId}, ${targetKey}, 1)
			`;
			await transaction`
				INSERT INTO background_jobs (
					id, channel_id, type, version, origin, target_key, target_generation,
					idempotency_key, fingerprint, input, state, revision, attempts, failures,
					claim_generation, available_at, created_at, updated_at
				) VALUES (
					${jobId}, ${channelId}, 'research-question', 1, 'user', ${targetKey}, 1,
					${`e2e-${jobId}`}, ${`fingerprint-${jobId}`},
					${
				JSON.stringify({
					questionId,
					question,
					questionHash: `sha256:${"0".repeat(64)}`,
					revision: 0,
				})
			}::jsonb,
					'completed', 1, 1, 0, 1, ${now}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO background_job_artifacts (job_id, revision, value, created_at)
				VALUES (
					${jobId}, 1,
					${
				JSON.stringify({
					questionId,
					question,
					questionHash: `sha256:${"0".repeat(64)}`,
					revision: 0,
					report: {
						title: "Preview research report",
						summary: "The preview report is visible outside Conversation.",
						findings: [{ text: "A cited finding", sourceUrls: ["https://example.com/source"] }],
						caveats: ["Generated evidence should be reviewed."],
					},
					sources: [{ title: "Example source", url: "https://example.com/source" }],
					documentRevision: 0,
					documentSourceHash: `sha256:${"1".repeat(64)}`,
					model: "e2e-model",
				})
			}::jsonb,
					${now}
				)
			`;
		});
	});
}

/** The checkpoint that `plan:open` starts from, for protocol-level browser fixtures. */
export async function readDocument(port: number, id: string): Promise<{
	epoch: string;
	source: string;
	update: Uint8Array;
}> {
	return sql(port, async database => {
		let [row] = await database<{ document: Uint8Array; epoch: string; source: string }[]>`
			SELECT epoch, source, document FROM channel_snapshots WHERE channel_id = ${id}
		`;
		if (!row) throw new Error(`missing checkpoint for ${id}`);
		return { epoch: row.epoch, source: row.source, update: new Uint8Array(row.document) };
	});
}
