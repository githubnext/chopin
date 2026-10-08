import { SQL } from "bun";
import { ulid } from "../packages/dialect/src/ulid";
import { testChannelPath } from "./database";

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
	// The research service mints UUID request ids; the document must accept that shape.
	let workspaceId = crypto.randomUUID();
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

export async function seedCompletedResearchWorkspace(
	port: number,
	channelId: string,
	fixture: {
		workspaceId?: string;
		answerJobId?: string;
		plannerOriginMessageId?: string;
		question: string;
		report: {
			title: string;
			summary: string;
			finding: string;
			caveat: string;
			source: { title: string; url: string };
		};
	},
): Promise<{ workspaceId: string; path: string }> {
	let workspaceId = fixture.workspaceId ?? `workspace-${crypto.randomUUID()}`;
	let turnId = `turn-${crypto.randomUUID()}`;
	let evidenceJobId = `job-${crypto.randomUUID()}`;
	let answerJobId = fixture.answerJobId ?? `job-${crypto.randomUUID()}`;
	let evidenceTarget = `research-evidence:workspace:${workspaceId}:turn:${turnId}:evidence`;
	let answerTarget = `research-answer:workspace:${workspaceId}:turn:${turnId}:answer`;
	let createdAt = new Date();
	let confirmedAt = new Date(createdAt.getTime() + 1);
	let evidenceCreatedAt = new Date(createdAt.getTime() + 2);
	let evidenceCompletedAt = new Date(createdAt.getTime() + 3);
	let answerCreatedAt = new Date(createdAt.getTime() + 4);
	let answerCompletedAt = new Date(createdAt.getTime() + 5);
	let completedAt = new Date(createdAt.getTime() + 6);

	await sql(port, async database => {
		let [document] = await database<
			{
				revision: bigint | number | string;
				source: string;
				sourceHash: string;
			}[]
		>`
			SELECT revision, source, source_hash AS "sourceHash"
			FROM channel_snapshots
			WHERE channel_id = ${channelId}
		`;
		if (!document) throw new Error(`missing checkpoint for ${channelId}`);
		let documentRevision = Number(document.revision);
		let evidence = {
			workspaceId,
			turnId,
			query: fixture.question,
			findings: [fixture.report.finding],
			sources: [fixture.report.source],
			model: "e2e-research-model",
		};
		let answerInput = {
			workspaceId,
			turnId,
			kind: "initial",
			question: fixture.question,
			document: {
				source: document.source,
				revision: documentRevision,
				sourceHash: document.sourceHash,
			},
			evidence: [{
				findings: [fixture.report.finding],
				sources: [fixture.report.source],
			}],
			history: [{ author: "member", text: fixture.question }],
		};
		let answerArtifact = {
			workspaceId,
			turnId,
			kind: "initial",
			documentRevision,
			documentSourceHash: document.sourceHash,
			model: "e2e-research-model",
			report: {
				title: fixture.report.title,
				summary: fixture.report.summary,
				findings: [{
					text: fixture.report.finding,
					sourceUrls: [fixture.report.source.url],
				}],
				caveats: [fixture.report.caveat],
			},
			sources: [fixture.report.source],
			publicFindings: [fixture.report.finding],
			privateFindings: ["The private parent document supplied additional context."],
		};

		// Workspace and job revisions mirror their minimal durable production lifecycles.
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO background_job_channels (channel_id, revision)
				VALUES (${channelId}, 6)
			`;
			await transaction`
				INSERT INTO background_job_targets (channel_id, target_key, generation)
				VALUES
					(${channelId}, ${evidenceTarget}, 1),
					(${channelId}, ${answerTarget}, 1)
			`;
			await transaction`
				INSERT INTO background_jobs (
					id, channel_id, type, version, origin, target_key, target_generation,
					idempotency_key, fingerprint, input, state, revision, attempts, failures,
					claim_generation, available_at, created_at, updated_at
				) VALUES (
					${evidenceJobId}, ${channelId}, 'research-evidence', 1, 'user',
					${evidenceTarget}, 1, ${`research-evidence:${turnId}`},
					${`fingerprint-${evidenceJobId}`},
					${JSON.stringify({ workspaceId, turnId, query: fixture.question })}::jsonb,
					'completed', 3, 1, 0, 1, ${evidenceCreatedAt}, ${evidenceCreatedAt},
					${evidenceCompletedAt}
				), (
					${answerJobId}, ${channelId}, 'research-answer', 1, 'user',
					${answerTarget}, 1, ${`research-answer:${turnId}`},
					${`fingerprint-${answerJobId}`}, ${JSON.stringify(answerInput)}::jsonb,
					'completed', 6, 1, 0, 1, ${answerCreatedAt}, ${answerCreatedAt},
					${answerCompletedAt}
				)
			`;
			await transaction`
				INSERT INTO background_job_artifacts (job_id, revision, value, created_at)
				VALUES
					(${evidenceJobId}, 3, ${JSON.stringify(evidence)}::jsonb, ${evidenceCompletedAt}),
					(${answerJobId}, 6, ${JSON.stringify(answerArtifact)}::jsonb, ${answerCompletedAt})
			`;
			await transaction`
				INSERT INTO research_workspaces (
					id, channel_id, title, proposed_question, confirmed_query, origin,
					origin_message_id, inline_reference,
					created_by, confirmed_by, revision, next_turn_ordinal, next_message_sequence,
					idempotency_key, fingerprint, created_at, updated_at
				) VALUES (
					${workspaceId}, ${channelId}, ${fixture.question}, ${fixture.question},
					${fixture.question}, ${fixture.plannerOriginMessageId ? "planner" : "sidebar"},
					${fixture.plannerOriginMessageId ?? null},
					${fixture.plannerOriginMessageId ? "placed" : null},
					'U_e2e', 'U_e2e', 4, 2, 3,
					${`e2e-workspace-${workspaceId}`}, ${`fingerprint-${workspaceId}`},
					${createdAt}, ${completedAt}
				)
			`;
			await transaction`
				INSERT INTO research_turns (
					id, workspace_id, ordinal, kind, request_id, fingerprint, question,
					requested_by, evidence_job_id, answer_job_id, created_at, updated_at
				) VALUES (
					${turnId}, ${workspaceId}, 1, 'initial', ${crypto.randomUUID()},
					${`fingerprint-${turnId}`}, ${fixture.question}, 'U_e2e', ${evidenceJobId},
					${answerJobId}, ${confirmedAt}, ${answerCreatedAt}
				)
			`;
			await transaction`
				INSERT INTO research_messages (
					id, workspace_id, sequence, turn_id, author_kind, user_id, user_handle,
					text, source_job_id, created_at
				) VALUES (
					${`message-${crypto.randomUUID()}`}, ${workspaceId}, 1, ${turnId}, 'member',
					'U_e2e', 'e2e', ${fixture.question}, NULL, ${confirmedAt}
				), (
					${`message-${crypto.randomUUID()}`}, ${workspaceId}, 2, ${turnId}, 'agent',
					NULL, NULL, ${fixture.report.summary}, ${answerJobId}, ${completedAt}
				)
			`;
		});
	});

	return {
		workspaceId,
		path: `${testChannelPath(channelId)}/research/${encodeURIComponent(workspaceId)}`,
	};
}
