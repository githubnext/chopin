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

export async function seedChannelDescription(
	port: number,
	id: string,
	description: string,
): Promise<void> {
	await sql(port, async database => {
		await database`
			UPDATE channels
			SET generated_description = ${description},
				generated_description_revision = 1,
				generated_description_plan_revision = 0,
				generated_description_source_hash = ${`sha256:${"a".repeat(64)}`},
				generated_description_generator_version = 1,
				generated_description_job_id = ${`e2e-description-${id}`},
				generated_description_updated_at = ${new Date()}
			WHERE id = ${id}
		`;
	});
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

function researchAnswerFixture(question: string) {
	let workspaceId = `workspace-${crypto.randomUUID()}`;
	let turnId = `turn-${crypto.randomUUID()}`;
	let documentSource = "# Research parent\n";
	let documentSourceHash = `sha256:${createHash("sha256").update(documentSource).digest("hex")}`;
	return {
		workspaceId,
		turnId,
		targetKey: `research-answer:workspace:${workspaceId}:turn:${turnId}:answer`,
		input: {
			workspaceId,
			turnId,
			kind: "initial",
			question,
			document: {
				source: documentSource,
				revision: 0,
				sourceHash: documentSourceHash,
			},
			evidence: [],
			history: [],
		},
		artifact: {
			workspaceId,
			turnId,
			kind: "initial",
			documentRevision: 0,
			documentSourceHash,
			model: "e2e-model",
			report: {
				title: "Preview research report",
				summary: "The preview report is visible outside Conversation.",
				findings: [{ text: "A cited finding", sourceUrls: ["https://example.com/source"] }],
				caveats: ["Generated evidence should be reviewed."],
			},
			sources: [{ title: "Example source", url: "https://example.com/source" }],
			publicFindings: ["A cited finding"],
			privateFindings: [],
		},
	};
}

export async function seedCompletedResearchAnswerJob(
	port: number,
	channelId: string,
	question: string,
): Promise<string> {
	let now = new Date();
	let jobId = crypto.randomUUID();
	let fixture = researchAnswerFixture(question);
	await sql(port, async database => {
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO background_job_channels (channel_id, revision) VALUES (${channelId}, 1)
			`;
			await transaction`
				INSERT INTO background_job_targets (channel_id, target_key, generation)
				VALUES (${channelId}, ${fixture.targetKey}, 1)
			`;
			await transaction`
				INSERT INTO background_jobs (
					id, channel_id, type, version, origin, target_key, target_generation,
					idempotency_key, fingerprint, input, state, revision, attempts, failures,
					claim_generation, available_at, created_at, updated_at
				) VALUES (
					${jobId}, ${channelId}, 'research-answer', 1, 'user', ${fixture.targetKey}, 1,
					${`e2e-${jobId}`}, ${`fingerprint-${jobId}`},
					${JSON.stringify(fixture.input)}::jsonb,
					'completed', 1, 1, 0, 1, ${now}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO background_job_artifacts (job_id, revision, value, created_at)
				VALUES (
					${jobId}, 1,
					${JSON.stringify(fixture.artifact)}::jsonb,
					${now}
				)
			`;
		});
	});
	return jobId;
}

export async function seedRunningResearchAnswerJob(
	port: number,
	channelId: string,
	question: string,
): Promise<void> {
	let now = new Date();
	let jobId = crypto.randomUUID();
	let fixture = researchAnswerFixture(question);
	let progress = [{
		revision: 2,
		attempt: 1,
		stage: "private-document",
		label: "Private document analysis",
		state: "started",
		createdAt: now.toISOString(),
	}, {
		revision: 3,
		attempt: 1,
		stage: "private-document",
		label: "Private document analysis",
		state: "interrupted",
		reason: "private-analysis-failed",
		createdAt: new Date(now.getTime() + 1).toISOString(),
	}, {
		revision: 4,
		attempt: 2,
		stage: "private-document",
		label: "Private document analysis",
		state: "started",
		createdAt: new Date(now.getTime() + 2).toISOString(),
	}, {
		revision: 5,
		attempt: 2,
		stage: "private-document",
		label: "Private document analysis",
		state: "completed",
		createdAt: new Date(now.getTime() + 3).toISOString(),
	}, {
		revision: 6,
		attempt: 2,
		stage: "report-synthesis",
		label: "Research report synthesis",
		state: "started",
		createdAt: new Date(now.getTime() + 4).toISOString(),
	}];
	await sql(port, async database => {
		await database.begin(async transaction => {
			await transaction`
				INSERT INTO background_job_channels (channel_id, revision) VALUES (${channelId}, 6)
			`;
			await transaction`
				INSERT INTO background_job_targets (channel_id, target_key, generation)
				VALUES (${channelId}, ${fixture.targetKey}, 1)
			`;
			await transaction`
				INSERT INTO background_jobs (
					id, channel_id, type, version, origin, target_key, target_generation,
					idempotency_key, fingerprint, input, state, revision, attempts, failures,
					claim_generation, claim_owner, claim_expires_at, available_at, progress,
					created_at, updated_at
				) VALUES (
					${jobId}, ${channelId}, 'research-answer', 1, 'user', ${fixture.targetKey}, 1,
					${`e2e-${jobId}`}, ${`fingerprint-${jobId}`},
					${JSON.stringify(fixture.input)}::jsonb,
					'running', 6, 2, 1, 2, 'e2e-worker', ${new Date(now.getTime() + 60_000)},
					${now}, ${JSON.stringify(progress)}::text::jsonb, ${now}, ${new Date(now.getTime() + 4)}
				)
			`;
		});
	});
}

export async function seedCompletedResearchWorkspace(
	port: number,
	channelId: string,
	fixture: {
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
	let workspaceId = `workspace-${crypto.randomUUID()}`;
	let turnId = `turn-${crypto.randomUUID()}`;
	let evidenceJobId = `job-${crypto.randomUUID()}`;
	let answerJobId = `job-${crypto.randomUUID()}`;
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
					created_by, confirmed_by, revision, next_turn_ordinal, next_message_sequence,
					idempotency_key, fingerprint, created_at, updated_at
				) VALUES (
					${workspaceId}, ${channelId}, ${fixture.question}, ${fixture.question},
					${fixture.question}, 'sidebar', 'U_e2e', 'U_e2e', 4, 2, 3,
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

export async function readResearchWorkspaceState(
	port: number,
	channelId: string,
	workspaceId: string,
): Promise<{
	confirmed: boolean;
	revision: number;
	nextTurnOrdinal: number;
	nextMessageSequence: number;
	turns: number;
	messages: number;
	jobs: number;
}> {
	return sql(port, async database => {
		let [row] = await database<
			{
				confirmedQuery: string | null;
				revision: bigint | number | string;
				nextTurnOrdinal: bigint | number | string;
				nextMessageSequence: bigint | number | string;
				turns: number;
				messages: number;
				jobs: number;
			}[]
		>`
			SELECT
				confirmed_query AS "confirmedQuery",
				revision,
				next_turn_ordinal AS "nextTurnOrdinal",
				next_message_sequence AS "nextMessageSequence",
				(SELECT count(*)::int FROM research_turns WHERE workspace_id = ${workspaceId}) AS turns,
				(SELECT count(*)::int FROM research_messages WHERE workspace_id = ${workspaceId}) AS messages,
				(
					SELECT count(*)::int FROM background_jobs
					WHERE channel_id = ${channelId} AND input ->> 'workspaceId' = ${workspaceId}
				) AS jobs
			FROM research_workspaces
			WHERE id = ${workspaceId} AND channel_id = ${channelId}
		`;
		if (!row) throw new Error(`missing research workspace ${workspaceId}`);
		return {
			confirmed: row.confirmedQuery !== null,
			revision: Number(row.revision),
			nextTurnOrdinal: Number(row.nextTurnOrdinal),
			nextMessageSequence: Number(row.nextMessageSequence),
			turns: row.turns,
			messages: row.messages,
			jobs: row.jobs,
		};
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
