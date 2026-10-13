import { investigationSchema } from "@chopin/experiment/records";
import type { Investigation } from "@chopin/experiment/records";
import type { SQL, TransactionSQL } from "bun";
import { deterministicChannelId } from "../../channels/id";
import type { ExperimentStore, InvestigationChildInput } from "../experiments";
import type { ChannelRecord, CreateChannel, Lease } from "../model";
import { conflict, missing } from "../errors";

function decode(value: unknown): Investigation {
	return investigationSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

export class PostgresExperimentStore implements ExperimentStore {
	constructor(
		private sql: SQL,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
		private createChannel: (sql: TransactionSQL, input: CreateChannel) => Promise<ChannelRecord>,
	) {}
	async get(id: string) {
		let [row] = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE id = ${id}`;
		return row ? decode(row.payload) : undefined;
	}
	async list(documentId: string) {
		let rows = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE channel_id = ${documentId} ORDER BY created_at DESC LIMIT 100`;
		return rows.map(row => decode(row.payload));
	}
	async published(childId: string) {
		let [row] = await this.sql<
			{ payload: unknown }[]
		>`SELECT experiments.payload FROM experiments
			JOIN channels ON channels.id = experiments.channel_id
			WHERE experiments.child_channel_id = ${childId}`;
		return row ? decode(row.payload) : undefined;
	}
	async active() {
		let rows = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE state IN ('queued', 'running', 'publishing')`;
		return rows.map(row => decode(row.payload));
	}
	async save(value: Investigation, expected: number | undefined, lease: Lease): Promise<boolean> {
		let parsed = investigationSchema.parse(value);
		if (value.revision !== (expected === undefined ? 0 : expected + 1)) {
			throw conflict("invalid experiment revision");
		}
		return await this.sql.begin(async sql => {
			await this.fence(sql, lease);
			let [channel] =
				await sql`SELECT id, archived_at FROM channels WHERE id = ${value.documentId} FOR UPDATE`;
			if (!channel) throw missing("experiment document not found");
			if (channel.archived_at && !["failed", "cancelled", "interrupted"].includes(value.state)) {
				throw conflict("experiment document archived");
			}
			let rows = expected === undefined
				? await sql`INSERT INTO experiments (id, channel_id, revision, state, created_at, payload)
					VALUES (${value.id}, ${value.documentId}, 0, ${value.state}, ${new Date(
					value.createdAt,
				)}, ${JSON.stringify(parsed)}::jsonb)
					ON CONFLICT DO NOTHING RETURNING id`
				: await sql`UPDATE experiments SET revision = ${value.revision}, state = ${value.state}, payload = ${
					JSON.stringify(parsed)
				}::jsonb
					WHERE id = ${value.id} AND channel_id = ${value.documentId} AND revision = ${expected} RETURNING id`;
			return rows.length === 1;
		}) as boolean;
	}
	async publish(
		value: Investigation,
		expected: number,
		child: InvestigationChildInput,
		lease: Lease,
	): Promise<Investigation | false> {
		if (
			value.revision !== expected + 1 || value.state !== "completed" || !value.result
			|| value.spike
		) {
			throw conflict("invalid experiment publication");
		}
		return await this.sql.begin(async sql => {
			await this.fence(sql, lease);
			let [channel] = await sql<{
				repositoryId: string;
				repositoryOwner: string;
				repositoryName: string;
				parentChannelId: string | null;
				archivedAt: Date | null;
			}[]>`SELECT repository_id AS "repositoryId", repository_owner AS "repositoryOwner",
					repository_name AS "repositoryName", parent_channel_id AS "parentChannelId",
					archived_at AS "archivedAt"
				FROM channels WHERE id = ${value.documentId} FOR UPDATE`;
			if (!channel) throw missing("experiment document not found");
			let [row] = await sql<{ revision: string | number; payload: unknown }[]>`
				SELECT revision, payload FROM experiments
				WHERE id = ${value.id} AND channel_id = ${value.documentId} FOR UPDATE`;
			if (!row) throw missing("experiment not found");
			let current = decode(row.payload);
			if (current.childId) return current;
			if (Number(row.revision) !== expected) return false;
			if (channel.archivedAt) throw conflict("experiment document archived");
			// A child document never holds investigations, so it never publishes one either.
			if (channel.parentChannelId) throw conflict("experiment document is a child");
			let childId = deterministicChannelId(channel.repositoryId, `investigation:${value.id}`);
			await this.createChannel(sql, {
				id: childId,
				repositoryId: channel.repositoryId,
				repositoryOwner: channel.repositoryOwner,
				repositoryName: channel.repositoryName,
				parentChannelId: value.documentId,
				title: child.title,
				createdBy: value.requester,
				now: child.now,
				initial: child.initial,
			});
			let saved = investigationSchema.parse({ ...value, childId });
			await sql`UPDATE experiments SET revision = ${saved.revision}, state = ${saved.state},
				child_channel_id = ${childId}, payload = ${JSON.stringify(saved)}::jsonb
				WHERE id = ${saved.id}`;
			return saved;
		}) as Investigation | false;
	}
}
