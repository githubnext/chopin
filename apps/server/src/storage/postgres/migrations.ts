import { join } from "node:path";

import type { SQL } from "bun";

const MIGRATIONS = [{
	id: "001_initial",
	path: join(import.meta.dir, "migrations/001_initial.sql"),
}];

/** Stable across deployments; it serializes migrations, not ordinary writes. */
const MIGRATION_LOCK = 2_043_237_431;

type Applied = { id: string; checksum: string };
type Expected = { id: string; source: string; checksum: string };

function checksum(source: string): string {
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

async function expected(): Promise<Expected[]> {
	return Promise.all(MIGRATIONS.map(async migration => {
		let source = await Bun.file(migration.path).text();
		return { id: migration.id, source, checksum: checksum(source) };
	}));
}

function checked(rows: Applied[], migrations: Expected[], complete: boolean): Map<string, string> {
	let known = new Map(migrations.map(migration => [migration.id, migration.checksum]));
	let applied = new Map<string, string>();
	for (let row of rows) {
		let digest = known.get(row.id);
		if (!digest) throw new Error(`database has unknown migration ${row.id}`);
		if (digest !== row.checksum) {
			throw new Error(`migration ${row.id} changed after it was applied`);
		}
		applied.set(row.id, row.checksum);
	}
	if (complete) {
		let missing = migrations.find(migration => !applied.has(migration.id));
		if (missing) throw new Error(`database is missing migration ${missing.id}`);
	}
	return applied;
}

export async function migrate(sql: SQL): Promise<void> {
	let migrations = await expected();
	await sql.begin(async transaction => {
		await transaction`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`;
		await transaction`
			CREATE TABLE IF NOT EXISTS chopin_migrations (
				id text PRIMARY KEY,
				checksum text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)
		`;

		let rows = await transaction<Applied[]>`SELECT id, checksum FROM chopin_migrations`;
		let applied = checked(rows, migrations, false);
		for (let migration of migrations) {
			let previous = applied.get(migration.id);
			if (previous) continue;
			await transaction.unsafe(migration.source).simple();
			await transaction`
				INSERT INTO chopin_migrations (id, checksum)
				VALUES (${migration.id}, ${migration.checksum})
			`;
		}
	});
}

export async function verifyMigrations(sql: SQL): Promise<void> {
	let migrations = await expected();
	let rows = await sql<Applied[]>`SELECT id, checksum FROM chopin_migrations`;
	checked(rows, migrations, true);
}
