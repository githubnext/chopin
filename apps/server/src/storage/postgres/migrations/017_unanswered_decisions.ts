import type { TransactionSQL } from "bun";

const BATCH_SIZE = 500;

type JsonObject = { [key: string]: unknown };

type State = { channelId: string; sidecar: unknown };

function object(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function parsed(sidecar: unknown): unknown {
	if (typeof sidecar !== "string") return sidecar;
	try {
		return JSON.parse(sidecar);
	} catch {
		return undefined;
	}
}

export function migratedUnansweredDecisions(sidecar: unknown): number {
	let records = object(parsed(sidecar))?.questions;
	if (!Array.isArray(records)) return 0;
	let total = 0;
	for (let entry of records) {
		let record = object(entry);
		let questions = object(record?.definition)?.questions;
		if (!record || !Array.isArray(questions)) continue;
		if (record.status === "reopened") {
			total += questions.length;
			continue;
		}
		if (record.status !== "open") continue;
		let answers = object(record.answers);
		for (let question of questions) {
			let id = object(question)?.id;
			if (!answers || !Object.hasOwn(answers, typeof id === "string" ? id : "")) total++;
		}
	}
	return total;
}

export async function backfillUnansweredDecisions(sql: TransactionSQL): Promise<void> {
	let after = "";
	while (true) {
		let rows = await sql<State[]>`
			SELECT channel_id AS "channelId", sidecar
			FROM channel_state
			WHERE channel_id > ${after}
			ORDER BY channel_id
			LIMIT ${BATCH_SIZE}
			FOR UPDATE
		`;
		if (rows.length === 0) return;
		for (let row of rows) {
			let unanswered = migratedUnansweredDecisions(row.sidecar);
			if (unanswered === 0) continue;
			await sql`
				UPDATE channel_state
				SET unanswered_decisions = ${unanswered}
				WHERE channel_id = ${row.channelId}
			`;
		}
		after = rows.at(-1)!.channelId;
	}
}
