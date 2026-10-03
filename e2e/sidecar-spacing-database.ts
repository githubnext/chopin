import { createHash } from "node:crypto";
import { SQL } from "bun";
import { storedCardGapDocument } from "../apps/server/src/testing/card-gap-document";
import { storedDocument } from "../apps/server/src/testing/plan";

import type { SeedState } from "../apps/server/src/testing/plan";

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

export async function seedCardGapChannel(port: number, id: string, source: string): Promise<void> {
	return seed(port, id, source, {}, storedCardGapDocument);
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
