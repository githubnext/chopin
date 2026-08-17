import { join } from "node:path";

import type { SQL } from "bun";

const MIGRATIONS = [{
	id: "001_initial",
	path: join(import.meta.dir, "migrations/001_initial.sql"),
}, {
	id: "002_process_local_sessions",
	path: join(import.meta.dir, "migrations/002_process_local_sessions.sql"),
}];

/** Stable across deployments; it serializes migrations, not ordinary writes. */
const MIGRATION_LOCK = 2_043_237_431;
const MIGRATION_RELEASE_FENCE_MS = 1_000;
const MIGRATION_HANDOFF_FENCE_MS = 30_000;
const MIGRATION_EXECUTION_FENCE_MS = 5 * 60_000;

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

export async function migrate(sql: SQL, handoffOwner?: string): Promise<void> {
	let migrations = await expected();
	let waitForRelease = false;
	await sql.begin(async transaction => {
		let fenceOwner: string | undefined;
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
		let writerChecked = false;
		for (let migration of migrations) {
			let previous = applied.get(migration.id);
			if (previous) continue;
			if (migration.id !== "001_initial" && !writerChecked) {
				await transaction`LOCK TABLE storage_leases IN SHARE ROW EXCLUSIVE MODE`;
				let owner = handoffOwner || `migration:${crypto.randomUUID()}`;
				let [fence] = await transaction<{ expiresAt: Date | string }[]>`
					INSERT INTO storage_leases (name, owner, fencing, expires_at)
					VALUES (
						'chopin:writer', ${owner}, 1,
						clock_timestamp()
							+ (${MIGRATION_EXECUTION_FENCE_MS} * interval '1 millisecond')
					)
					ON CONFLICT (name) DO UPDATE SET
						owner = EXCLUDED.owner,
						fencing = storage_leases.fencing + 1,
						expires_at = EXCLUDED.expires_at
					WHERE storage_leases.expires_at <= clock_timestamp()
					RETURNING expires_at AS "expiresAt"
				`;
				if (!fence) throw new Error("cannot migrate while a Chopin writer is active");
				fenceOwner = owner;
				writerChecked = true;
			}
			await transaction.unsafe(migration.source).simple();
			await transaction`
				INSERT INTO chopin_migrations (id, checksum)
				VALUES (${migration.id}, ${migration.checksum})
			`;
		}
		if (fenceOwner) {
			let fenceMs = handoffOwner ? MIGRATION_HANDOFF_FENCE_MS : MIGRATION_RELEASE_FENCE_MS;
			let [released] = await transaction<{ expiresAt: Date | string }[]>`
				UPDATE storage_leases
				SET expires_at = clock_timestamp() + (${fenceMs} * interval '1 millisecond')
				WHERE name = 'chopin:writer' AND owner = ${fenceOwner}
				RETURNING expires_at AS "expiresAt"
			`;
			if (!released) throw new Error("migration lost the database writer fence");
			waitForRelease = !handoffOwner;
		}
	});
	if (waitForRelease) await Bun.sleep(MIGRATION_RELEASE_FENCE_MS);
}

export async function verifyMigrations(sql: SQL): Promise<void> {
	let migrations = await expected();
	let rows = await sql<Applied[]>`SELECT id, checksum FROM chopin_migrations`;
	checked(rows, migrations, true);
}
