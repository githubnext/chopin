import { createHash } from "node:crypto";
import { SQL } from "bun";
import { investigationSchema } from "../packages/experiment/src/records";
import { parseResult } from "../packages/experiment/src/index";
import { seedChildChannel } from "./database";
import {
	markResearchPublished,
	seedCompletedResearchWorkspace,
} from "./research-recovery-database";

import type { Followthrough } from "../packages/protocol/index";

export type PublishedResult = {
	kind: "research" | "investigation";
	sourceId: string;
	title: string;
	child: { id: string; path: string; slug: string };
	receipt: Followthrough.View;
};

function databaseUrl(port: number): string {
	let index = [8788, 8789, 8792].indexOf(port);
	if (index < 0) throw new Error("Followthrough fixtures require a disposable E2E server.");
	return process.env[`E2E_DATABASE_URL_${index}`]
		?? `postgresql://chopin:chopin@127.0.0.1:${5433 + index}/chopin?sslmode=disable`;
}

/** A pre-existing published result; publication atomicity is covered by storage contracts. */
export async function seedPublishedResult(
	port: number,
	channelId: string,
	kind: PublishedResult["kind"],
	sourceId: string,
	status: Followthrough.Status,
	brief = "Compare startup approaches before choosing the cache.",
	buildBlocker?: string,
): Promise<PublishedResult> {
	let title = kind === "research" ? "Cache research findings" : "Startup investigation findings";
	let summary = "The captured comparison challenges the current cache recommendation.";
	let finding = "The captured large workload benefits less from caching than the small workload.";
	let child = await seedChildChannel(
		port,
		channelId,
		crypto.randomUUID(),
		title,
		`# ${title}\n\n${summary}\n\n${finding}\n\nThis fixture leaves the final cache choice open.\n`,
	);
	let resultKey = kind === "research" ? `job-${crypto.randomUUID()}` : "1";
	if (kind === "research") {
		await seedCompletedResearchWorkspace(port, channelId, {
			workspaceId: sourceId,
			answerJobId: resultKey,
			question: brief,
			report: {
				title,
				summary,
				finding,
				caveat: "Illustrative captured data; validate with the real workload.",
				source: { title: "Startup comparison notes", url: "https://example.com/startup" },
			},
		});
		await markResearchPublished(port, channelId, sourceId, child.id);
	}
	let reason = status === "pending"
		? "owner-unavailable"
		: status === "failed"
		? "interrupted"
		: status === "skipped"
		? "dismissed"
		: undefined;
	let id = createHash("sha256").update(JSON.stringify([
		channelId,
		kind,
		sourceId,
		resultKey,
	])).digest("hex");
	let receipt: Followthrough.View = { id, revision: 0, status, ...(reason ? { reason } : {}) };
	let now = new Date();
	let database = new SQL(databaseUrl(port));
	try {
		await database.begin(async transaction => {
			if (kind === "investigation") {
				let value = investigationSchema.parse({
					id: sourceId,
					documentId: channelId,
					revision: 1,
					brief,
					requester: "U_e2e",
					state: "completed",
					...(buildBlocker ? { buildBlocker } : {}),
					generation: 1,
					expiresAt: 0,
					createdAt: now.getTime(),
					updatedAt: now.getTime(),
					progress: "",
					childId: child.id,
					result: parseResult({
						schemaVersion: 1,
						report: `# ${title}\n\n${finding}\n`,
						datasets: [],
						views: [],
						evidence: [],
						provenance: {
							environment: "Seeded E2E result",
							checks: [],
							limitations: ["Illustrative fixture"],
						},
					}),
					views: {},
					decisions: [],
					receipts: {},
				});
				await transaction`INSERT INTO experiments
					(id, channel_id, revision, state, created_at, payload, child_channel_id)
					VALUES (${sourceId}, ${channelId}, 1, 'completed', ${now},
						${JSON.stringify(value)}::jsonb, ${child.id})`;
			}
			let [snapshot] = await transaction<{ source_hash: string }[]>`
				SELECT source_hash FROM channel_snapshots WHERE channel_id = ${channelId}
			`;
			if (!snapshot) throw new Error("Followthrough parent must be seeded before its results.");
			let context = status === "running"
				? JSON.stringify({ planRevision: 0, sourceHash: snapshot.source_hash })
				: null;
			await transaction`INSERT INTO result_followthrough
				(id, channel_id, child_id, kind, source_id, result_key, status, revision, attempts,
					created_at, updated_at, reason, context, attempt_token)
				VALUES (${id}, ${channelId}, ${child.id}, ${kind}, ${sourceId}, ${resultKey}, ${status}, 0,
					${status === "pending" || status === "skipped" ? 0 : 1}, ${now}, ${now},
					${reason ?? null}, ${context}::jsonb, ${
				status === "running" ? crypto.randomUUID() : null
			})`;
		});
	} finally {
		await database.close();
	}
	return { kind, sourceId, title, child, receipt };
}

export async function persistedReview(port: number, channelId: string, id: string) {
	let database = new SQL(databaseUrl(port));
	try {
		let [value] = await database<{
			status: Followthrough.Status;
			revision: number;
			attempts: number;
			reason: string | null;
		}[]>`SELECT status, revision, attempts, reason FROM result_followthrough
			WHERE channel_id = ${channelId} AND id = ${id}`;
		return value;
	} finally {
		await database.close();
	}
}

/** A worker recovery commit whose notification a disconnected browser cannot receive. */
export async function recoverRunningReviews(port: number, channelId: string): Promise<number> {
	let database = new SQL(databaseUrl(port));
	try {
		let rows = await database`UPDATE result_followthrough
			SET status = 'failed', reason = 'interrupted', revision = revision + 1,
				updated_at = GREATEST(updated_at, now())
			WHERE channel_id = ${channelId} AND status = 'running' RETURNING id`;
		return rows.length;
	} finally {
		await database.close();
	}
}
