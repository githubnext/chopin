import { join } from "node:path";

import { backfillDocumentSlugs } from "./migrations/002_document_slugs";

import type { SQL, TransactionSQL } from "bun";

type Migration = {
	id: string;
	path: string;
	applyPath?: string;
	checksumTag?: string;
	apply?: (sql: TransactionSQL) => Promise<void>;
};

const MIGRATIONS = [{
	id: "001_initial",
	path: join(import.meta.dir, "migrations/001_initial.sql"),
}, {
	id: "002_document_slugs",
	path: join(import.meta.dir, "migrations/002_document_slugs.sql"),
	applyPath: join(import.meta.dir, "migrations/002_document_slugs.ts"),
	checksumTag: "apply:backfillDocumentSlugs:v1",
	apply: backfillDocumentSlugs,
}, {
	id: "003_user_navigation",
	path: join(import.meta.dir, "migrations/003_user_navigation.sql"),
}, {
	id: "004_background_jobs",
	path: join(import.meta.dir, "migrations/004_background_jobs.sql"),
}, {
	id: "005_background_job_failures",
	path: join(import.meta.dir, "migrations/005_background_job_failures.sql"),
}, {
	id: "006_background_job_progress",
	path: join(import.meta.dir, "migrations/006_background_job_progress.sql"),
}, {
	id: "007_research_workspaces",
	path: join(import.meta.dir, "migrations/007_research_workspaces.sql"),
}, {
	id: "008_research_repository_listing",
	path: join(import.meta.dir, "migrations/008_research_repository_listing.sql"),
}, {
	id: "009_navigation_revision",
	path: join(import.meta.dir, "migrations/009_navigation_revision.sql"),
}, {
	id: "010_document_archival",
	path: join(import.meta.dir, "migrations/010_document_archival.sql"),
}, {
	id: "011_document_descriptions",
	path: join(import.meta.dir, "migrations/011_document_descriptions.sql"),
}, {
	id: "012_child_channels",
	path: join(import.meta.dir, "migrations/012_child_channels.sql"),
}, {
	id: "013_research_child_publication",
	path: join(import.meta.dir, "migrations/013_research_child_publication.sql"),
}] satisfies Migration[];

/** Navigation shipped as 002 before document slugs claimed that number on main. */
const LEGACY_MIGRATION_IDS = new Map([["002_user_navigation", "003_user_navigation"]]);

/** Stable across deployments; it serializes migrations, not ordinary writes. */
const MIGRATION_LOCK = 2_043_237_431;

type Applied = { id: string; checksum: string };
type Expected = Migration & { source: string; checksum: string };

function checksum(source: string): string {
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

async function expected(): Promise<Expected[]> {
	return Promise.all(MIGRATIONS.map(async migration => {
		let source = await Bun.file(migration.path).text();
		let applySource = migration.applyPath ? await Bun.file(migration.applyPath).text() : "";
		let fingerprint = applySource || migration.checksumTag
			? `${source}\n-- ${migration.checksumTag ?? "data migration"}\n${applySource}`
			: source;
		return { ...migration, source, checksum: checksum(fingerprint) };
	}));
}

function checked(rows: Applied[], migrations: Expected[], complete: boolean): Map<string, string> {
	let known = new Map(migrations.map(migration => [migration.id, migration.checksum]));
	let applied = new Map<string, string>();
	for (let row of rows) {
		let id = LEGACY_MIGRATION_IDS.get(row.id) ?? row.id;
		let digest = known.get(id);
		if (!digest) throw new Error(`database has unknown migration ${row.id}`);
		if (digest !== row.checksum) {
			throw new Error(`migration ${row.id} changed after it was applied`);
		}
		if (applied.has(id)) throw new Error(`database has duplicate migration ${id}`);
		applied.set(id, row.checksum);
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
			await migration.apply?.(transaction);
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
