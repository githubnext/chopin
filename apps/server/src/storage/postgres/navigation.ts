import { corrupt, missing } from "../errors";

import type { SQL, TransactionSQL } from "bun";
import type {
	AddUserProject,
	AddUserProjectResult,
	RecordNavigationVisit,
	UserNavigation,
	UserProject,
} from "../model";
import type { NavigationStore } from "../port";

type Timestamp = Date | string;
type Integer = bigint | number | string;

type ProjectRow = {
	userId: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	position: Integer;
	addedAt: Timestamp;
};

type NavigationRow = {
	userId: string;
	lastDocumentId: string | null;
	updatedAt: Timestamp;
};

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;

const PROJECT_COLUMNS = `
	user_id AS "userId",
	repository_id AS "repositoryId",
	repository_owner AS "repositoryOwner",
	repository_name AS "repositoryName",
	position,
	added_at AS "addedAt"
`;

const NAVIGATION_COLUMNS = `
	user_id AS "userId",
	last_document_id AS "lastDocumentId",
	updated_at AS "updatedAt"
`;

function date(value: Timestamp, field: string): Date {
	let parsed = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function integer(value: Integer, field: string): number {
	let parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw corrupt(`storage returned an invalid ${field}`);
	}
	return parsed;
}

function project(row: ProjectRow): UserProject {
	return {
		...row,
		position: integer(row.position, "project position"),
		addedAt: date(row.addedAt, "project added time"),
	};
}

function navigation(row: NavigationRow): UserNavigation {
	return {
		...row,
		lastDocumentId: row.lastDocumentId ?? undefined,
		updatedAt: date(row.updatedAt, "navigation update time"),
	};
}

/** Per-user navigation queries, kept apart from the channel persistence engine. */
export class PostgresNavigationStore implements NavigationStore {
	readonly #sql: SQL;
	readonly #run: Run;

	constructor(sql: SQL, run: Run) {
		this.#sql = sql;
		this.#run = run;
	}

	readonly projects = (userId: string): Promise<UserProject[]> =>
		this.#run("list projects", async () => {
			await this.#requireUser(userId);
			let rows = await this.#sql<ProjectRow[]>`
				SELECT ${this.#sql.unsafe(PROJECT_COLUMNS)}
				FROM user_projects
				WHERE user_id = ${userId}
				ORDER BY position ASC
			`;
			return rows.map(project);
		});

	readonly addProject = (input: AddUserProject): Promise<AddUserProjectResult> =>
		this.#run(
			"add project",
			() => this.#sql.begin(transaction => this.#addProject(transaction, input)),
		);

	readonly get = (userId: string): Promise<UserNavigation | undefined> =>
		this.#run("read navigation", async () => {
			await this.#requireUser(userId);
			let [found] = await this.#sql<NavigationRow[]>`
				SELECT ${this.#sql.unsafe(NAVIGATION_COLUMNS)}
				FROM user_navigation WHERE user_id = ${userId}
			`;
			return found ? navigation(found) : undefined;
		});

	readonly setLastDocument = (
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation> =>
		this.#run("save navigation", () => this.#saveNavigation(this.#sql, userId, documentId, now));

	readonly recordVisit = (input: RecordNavigationVisit): Promise<UserNavigation> =>
		this.#run("record navigation visit", () =>
			this.#sql.begin(async transaction => {
				await this.#requireDocument(transaction, input.documentId, input.repositoryId);
				await this.#addProject(transaction, input);
				return this.#saveNavigation(transaction, input.userId, input.documentId, input.now);
			}));

	async #addProject(
		transaction: TransactionSQL,
		input: AddUserProject,
	): Promise<AddUserProjectResult> {
		await this.#lockUser(transaction, input.userId);
		let [existing] = await transaction<ProjectRow[]>`
			SELECT ${transaction.unsafe(PROJECT_COLUMNS)}
			FROM user_projects
			WHERE user_id = ${input.userId} AND repository_id = ${input.repositoryId}
		`;
		if (existing) return { project: project(existing), added: false };
		let [saved] = await transaction<ProjectRow[]>`
			INSERT INTO user_projects (
				user_id, repository_id, repository_owner, repository_name, position, added_at
			)
			SELECT
				${input.userId}, ${input.repositoryId}, ${input.repositoryOwner},
				${input.repositoryName}, COALESCE(MAX(position) + 1, 0), ${input.now}
			FROM user_projects
			WHERE user_id = ${input.userId}
			RETURNING ${transaction.unsafe(PROJECT_COLUMNS)}
		`;
		if (!saved) throw corrupt("adding a project returned no record");
		return { project: project(saved), added: true };
	}

	async #saveNavigation(
		sql: SQL | TransactionSQL,
		userId: string,
		documentId: string | undefined,
		now: Date,
	): Promise<UserNavigation> {
		let [saved] = await sql<NavigationRow[]>`
			INSERT INTO user_navigation (user_id, last_document_id, updated_at)
			VALUES (${userId}, ${documentId ?? null}, ${now})
			ON CONFLICT (user_id) DO UPDATE SET
				last_document_id = EXCLUDED.last_document_id,
				updated_at = EXCLUDED.updated_at
			RETURNING ${sql.unsafe(NAVIGATION_COLUMNS)}
		`;
		if (!saved) throw corrupt("saving navigation returned no record");
		return navigation(saved);
	}

	async #requireUser(userId: string): Promise<void> {
		let [found] = await this.#sql<{ id: string }[]>`
			SELECT id FROM users WHERE id = ${userId}
		`;
		if (!found) throw missing(`user ${userId} does not exist`);
	}

	async #lockUser(transaction: TransactionSQL, userId: string): Promise<void> {
		let [found] = await transaction<{ id: string }[]>`
			SELECT id FROM users WHERE id = ${userId} FOR UPDATE
		`;
		if (!found) throw missing(`user ${userId} does not exist`);
	}

	async #requireDocument(
		transaction: TransactionSQL,
		documentId: string,
		repositoryId: string,
	): Promise<void> {
		let [found] = await transaction<{ id: string }[]>`
			SELECT id FROM channels
			WHERE id = ${documentId} AND repository_id = ${repositoryId}
			FOR KEY SHARE
		`;
		if (!found) throw missing(`channel ${documentId} does not exist in repository ${repositoryId}`);
	}
}
