import { SQL } from "bun";
import { ulid } from "../packages/dialect/src/ulid";

const DEFAULT_DATABASES: Record<number, string> = {
	8788: "postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	8789: "postgresql://chopin:chopin@127.0.0.1:5434/chopin?sslmode=disable",
};

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

export async function seedPendingInlineResearchRequest(
	port: number,
	channelId: string,
	question: string,
	requestId: string,
	createdBy = "U_e2e",
	plannerOriginMessageId?: string,
): Promise<{ jobId: string; workspaceId: string }> {
	let workspaceId = ulid();
	let turnId = ulid();
	let messageId = ulid();
	let jobId = ulid();
	let targetKey = `research-evidence:workspace:${workspaceId}:turn:${turnId}:evidence`;
	let now = new Date();
	let availableAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	await sql(port, async database => {
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO background_job_channels (channel_id, revision)
				VALUES (${channelId}, 1)
				ON CONFLICT (channel_id) DO UPDATE
				SET revision = background_job_channels.revision + 1
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
					${jobId}, ${channelId}, 'research-evidence', 1, 'user', ${targetKey}, 1,
					${`research-evidence:${turnId}`}, ${`fingerprint-${jobId}`},
					${JSON.stringify({ workspaceId, turnId, query: question })}::jsonb,
					'pending', 1, 0, 0, 0, ${availableAt}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO research_workspaces (
					id, channel_id, title, proposed_question, confirmed_query, origin,
					origin_message_id, inline_reference,
					created_by, confirmed_by, revision, next_turn_ordinal, next_message_sequence,
					idempotency_key, fingerprint, created_at, updated_at
				) VALUES (
					${workspaceId}, ${channelId}, ${question}, ${question}, ${question},
					${plannerOriginMessageId ? "planner" : "inline"},
					${plannerOriginMessageId ?? null}, ${plannerOriginMessageId ? "placed" : null},
					${createdBy}, ${createdBy}, 0, 2, 2, ${`e2e-inline-${workspaceId}`},
					${`fingerprint-${workspaceId}`}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO research_turns (
					id, workspace_id, ordinal, kind, request_id, fingerprint, question,
					requested_by, evidence_job_id, created_at, updated_at
				) VALUES (
					${turnId}, ${workspaceId}, 1, 'initial', ${requestId},
					${`fingerprint-${turnId}`}, ${question}, ${createdBy}, ${jobId}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO research_messages (
					id, workspace_id, sequence, turn_id, author_kind, user_id, user_handle,
					text, created_at
				) VALUES (
					${messageId}, ${workspaceId}, 1, ${turnId}, 'member', ${createdBy}, 'e2e',
					${question}, ${now}
				)
			`;
		});
	});
	return { jobId, workspaceId };
}

export async function updateResearchJobState(
	port: number,
	channelId: string,
	jobId: string,
	state: "pending" | "completed" | "failed" | "cancelled",
): Promise<void> {
	await sql(port, async database => {
		let [updated] = await database<{ id: string }[]>`
			UPDATE background_jobs
			SET state = ${state},
				revision = revision + 1,
				reason = NULL,
				available_at = ${new Date(Date.now() + 24 * 60 * 60 * 1000)},
				updated_at = ${new Date()}
			WHERE id = ${jobId} AND channel_id = ${channelId}
			RETURNING id
		`;
		if (!updated) throw new Error(`missing scripted research job ${jobId}`);
	});
}

export async function markResearchPublished(
	port: number,
	channelId: string,
	workspaceId: string,
	childChannelId: string,
): Promise<void> {
	await sql(port, async database => {
		let [updated] = await database<{ id: string }[]>`
			UPDATE research_workspaces
			SET published_channel_id = ${childChannelId},
				updated_at = ${new Date()}
			WHERE id = ${workspaceId} AND channel_id = ${channelId}
			RETURNING id
		`;
		if (!updated) throw new Error(`missing scripted research workspace ${workspaceId}`);
	});
}
