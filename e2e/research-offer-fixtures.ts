import { createHash } from "node:crypto";
import { SQL } from "bun";
import {
	actOnResearchOffer,
	initialState,
	offerResearch,
} from "../apps/server/src/conversation-plan/domain";

import type { Chat, ConversationPlan } from "../packages/protocol/index";

export type OfferSpec = {
	id: string;
	brief: string;
	status: "accepted" | "offered";
	workspace?: "unlinked" | "linked";
};

function databaseUrl(): string {
	return process.env.E2E_DATABASE_URL_0
		?? "postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable";
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function offerSources(specs: readonly OfferSpec[], handle: string) {
	let state = initialState();
	let transcript: Chat.Entry[] = [];
	for (let [index, spec] of specs.entries()) {
		let entry: Chat.Entry = {
			id: `source-${spec.id}`,
			author: { kind: "member", handle },
			text: spec.brief,
			ts: index + 1,
		};
		transcript.push(entry);
		state = offerResearch(state, {
			id: spec.id,
			needId: `need-${spec.id}`,
			contextId: "context-v1",
			brief: entry.text,
			source: {
				messageId: entry.id,
				author: entry.author as Extract<Chat.Author, { kind: "member" }>,
				quote: entry.text,
				start: 0,
				end: entry.text.length,
			},
		}, entry);
		if (spec.status === "accepted") {
			state = actOnResearchOffer(state, spec.id, {
				id: `action-${spec.id}`,
				kind: "research",
				actor: { kind: "member", handle },
				principalId: `U_${handle}`,
				at: index + 10,
			});
		}
	}
	return { state, transcript };
}

export async function saveConversationState(
	channelId: string,
	state: ConversationPlan.State,
): Promise<void> {
	let database = new SQL(databaseUrl());
	try {
		let [row] = await database<{ sidecar: unknown }[]>`
			SELECT sidecar FROM channel_snapshots WHERE channel_id = ${channelId}
		`;
		if (!row) throw new Error("test channel snapshot was not seeded");
		let previous = typeof row.sidecar === "string"
			? JSON.parse(row.sidecar) as Record<string, unknown>
			: row.sidecar as Record<string, unknown>;
		let sidecar = JSON.stringify({ ...previous, conversationPlan: state });
		await database.begin(async transaction => {
			await transaction`
				UPDATE channel_snapshots SET sidecar = ${sidecar}::jsonb
				WHERE channel_id = ${channelId}
			`;
			await transaction`
				UPDATE channel_state SET sidecar = ${sidecar}::jsonb
				WHERE channel_id = ${channelId}
			`;
		});
	} finally {
		await database.close();
	}
}

export async function seedRequest(
	channelId: string,
	spec: OfferSpec,
	stage: "unlinked" | "linked",
	handle = "readonly",
): Promise<string> {
	let requestedBy = `U_${handle}`;
	let originMessageId = `source-${spec.id}`;
	let question = spec.brief;
	let workspaceId = `workspace-${crypto.randomUUID()}`;
	let turnId = crypto.randomUUID();
	let messageId = crypto.randomUUID();
	let jobId = stage === "linked" ? crypto.randomUUID() : undefined;
	let targetKey = jobId ? `research-evidence:${turnId}` : undefined;
	let now = new Date();
	let idempotencyKey = `research-planner:${digest(originMessageId).slice(0, 48)}`;
	let fingerprint = digest(`research-planner\0${
		JSON.stringify({
			channelId,
			question,
			originMessageId,
			requestedBy,
			requestedByHandle: handle,
		})
	}`);
	let database = new SQL(databaseUrl());
	try {
		await database.begin(async transaction => {
			if (jobId && targetKey) {
				await transaction`
					INSERT INTO background_job_channels (channel_id, revision)
					VALUES (${channelId}, 1)
				`;
				await transaction`
					INSERT INTO background_job_targets (channel_id, target_key, generation)
					VALUES (${channelId}, ${targetKey}, 1)
				`;
				await transaction`
					INSERT INTO background_jobs (
						id, channel_id, type, version, origin, target_key, target_generation,
						idempotency_key, fingerprint, input, state, revision, attempts,
						claim_generation, available_at, created_at, updated_at
					) VALUES (
						${jobId}, ${channelId}, 'research-evidence', 1, 'planner', ${targetKey}, 1,
						${`e2e-${jobId}`}, ${`fixture-${jobId}`},
						${JSON.stringify({ workspaceId, turnId, question })}::jsonb,
						'pending', 1, 0, 0, ${now}, ${now}, ${now}
					)
				`;
			}
			await transaction`
				INSERT INTO research_workspaces (
					id, channel_id, title, proposed_question, confirmed_query, origin,
					origin_message_id, inline_reference, created_by, confirmed_by,
					revision, next_turn_ordinal, next_message_sequence,
					idempotency_key, fingerprint, created_at, updated_at
				) VALUES (
					${workspaceId}, ${channelId}, ${question}, ${question}, ${question}, 'planner',
					${originMessageId}, ${stage === "linked" ? "placed" : "pending"},
					${requestedBy}, ${requestedBy}, 0, 2, 2,
					${idempotencyKey}, ${fingerprint}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO research_turns (
					id, workspace_id, ordinal, kind, request_id, fingerprint, question,
					requested_by, evidence_job_id, created_at, updated_at
				) VALUES (
					${turnId}, ${workspaceId}, 1, 'initial', ${originMessageId}, ${fingerprint},
					${question}, ${requestedBy}, ${jobId ?? null}, ${now}, ${now}
				)
			`;
			await transaction`
				INSERT INTO research_messages (
					id, workspace_id, sequence, turn_id, author_kind, user_id,
					user_handle, text, created_at
				) VALUES (
					${messageId}, ${workspaceId}, 1, ${turnId}, 'member', ${requestedBy},
					${handle}, ${question}, ${now}
				)
			`;
		});
	} finally {
		await database.close();
	}
	return workspaceId;
}

export async function transportState(channelIds: readonly string[]) {
	let database = new SQL(databaseUrl());
	try {
		let snapshots = [];
		for (let channelId of channelIds) {
			let [plan] = await database<{ revision: number | null }[]>`
				SELECT (sidecar->'conversationPlan'->>'revision')::int AS revision
				FROM channel_snapshots WHERE channel_id = ${channelId}
			`;
			let owners = await database<{ ownerSessionId: string | null; status: string }[]>`
				SELECT owner_session_id AS "ownerSessionId", status
				FROM agent_state WHERE channel_id = ${channelId}
				ORDER BY generation
			`;
			let jobs = await database<{ id: string; type: string; state: string; revision: number }[]>`
				SELECT id, type, state, revision FROM background_jobs
				WHERE channel_id = ${channelId} ORDER BY id
			`;
			let workspaces = await database<{
				id: string;
				inlineReference: string | null;
			}[]>`
				SELECT id, inline_reference AS "inlineReference" FROM research_workspaces
				WHERE channel_id = ${channelId} ORDER BY id
			`;
			let turns = await database<{
				id: string;
				evidenceJobId: string | null;
			}[]>`
				SELECT turns.id, turns.evidence_job_id AS "evidenceJobId"
				FROM research_turns AS turns
				JOIN research_workspaces AS workspaces ON workspaces.id = turns.workspace_id
				WHERE workspaces.channel_id = ${channelId} ORDER BY turns.id
			`;
			snapshots.push({ channelId, plan, owners, jobs, workspaces, turns });
		}
		return snapshots;
	} finally {
		await database.close();
	}
}

export async function researchWorkCounts(channelId: string): Promise<{
	jobs: number;
	owners: number;
	workspaces: number;
}> {
	let database = new SQL(databaseUrl());
	try {
		let [counts] = await database<{
			jobs: number;
			owners: number;
			workspaces: number;
		}[]>`
			SELECT
				(SELECT count(*)::int FROM background_jobs WHERE channel_id = ${channelId}) AS jobs,
				(SELECT count(*)::int FROM agent_state WHERE channel_id = ${channelId}) AS owners,
				(SELECT count(*)::int FROM research_workspaces WHERE channel_id = ${channelId}) AS workspaces
		`;
		if (!counts) throw new Error("could not read research work counts");
		return counts;
	} finally {
		await database.close();
	}
}
