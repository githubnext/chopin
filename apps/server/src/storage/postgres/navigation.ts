import { conflict, corrupt, missing } from "../errors";

import type { SQL, TransactionSQL } from "bun";
import type {
	AddUserProject,
	AddUserProjectResult,
	CompareNavigationResult,
	RecordNavigationVisit,
	UserNavigation,
	UserNavigationSnapshot,
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
	revision: Integer;
	updatedAt: Timestamp;
};

type SnapshotRow = {
	projectUserId: string | null;
	repositoryId: string | null;
	repositoryOwner: string | null;
	repositoryName: string | null;
	position: Integer | null;
	addedAt: Timestamp | null;
	navigationUserId: string | null;
	lastDocumentId: string | null;
	navigationRevision: Integer | null;
	navigationUpdatedAt: Timestamp | null;
	lastDocumentRepositoryId: string | null;
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
	revision,
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
		revision: integer(row.revision, "navigation revision"),
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

	readonly snapshot = (userId: string): Promise<UserNavigationSnapshot> =>
		this.#run("read navigation snapshot", async () => {
			let rows = await this.#sql<SnapshotRow[]>`
				SELECT
					user_projects.user_id AS "projectUserId",
					user_projects.repository_id AS "repositoryId",
					user_projects.repository_owner AS "repositoryOwner",
					user_projects.repository_name AS "repositoryName",
					user_projects.position,
					user_projects.added_at AS "addedAt",
					user_navigation.user_id AS "navigationUserId",
					user_navigation.last_document_id AS "lastDocumentId",
					user_navigation.revision AS "navigationRevision",
					user_navigation.updated_at AS "navigationUpdatedAt",
					selected.repository_id AS "lastDocumentRepositoryId"
				FROM users
				LEFT JOIN user_projects ON user_projects.user_id = users.id
				LEFT JOIN user_navigation ON user_navigation.user_id = users.id
				LEFT JOIN channels AS selected
					ON selected.id = user_navigation.last_document_id
					AND selected.archived_at IS NULL
				WHERE users.id = ${userId}
				ORDER BY user_projects.position ASC
			`;
			let first = rows[0];
			if (!first) throw missing(`user ${userId} does not exist`);
			let projects = rows.flatMap(row => {
				if (row.projectUserId === null) return [];
				if (
					row.repositoryId === null || row.repositoryOwner === null
					|| row.repositoryName === null || row.position === null || row.addedAt === null
				) throw corrupt("storage returned an invalid navigation project");
				return [project({
					userId: row.projectUserId,
					repositoryId: row.repositoryId,
					repositoryOwner: row.repositoryOwner,
					repositoryName: row.repositoryName,
					position: row.position,
					addedAt: row.addedAt,
				})];
			});
			let storedNavigation: UserNavigation | undefined;
			if (first.navigationUserId !== null) {
				if (first.navigationRevision === null || first.navigationUpdatedAt === null) {
					throw corrupt("storage returned an invalid navigation record");
				}
				storedNavigation = navigation({
					userId: first.navigationUserId,
					lastDocumentId: first.lastDocumentId,
					revision: first.navigationRevision,
					updatedAt: first.navigationUpdatedAt,
				});
			}
			return {
				projects,
				navigation: storedNavigation,
				lastDocumentRepositoryId: first.lastDocumentRepositoryId ?? undefined,
			};
		});

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

	readonly firstDocument = (
		userId: string,
		repositoryIds: string[],
	): Promise<string | undefined> =>
		this.#run("read first navigation document", async () => {
			if (repositoryIds.length === 0) return undefined;
			let [found] = await this.#sql<{ id: string }[]>`
				SELECT selected.id
				FROM user_projects
				CROSS JOIN LATERAL (
					SELECT channels.id
					FROM channels
					WHERE channels.repository_id = user_projects.repository_id
						AND channels.archived_at IS NULL
					ORDER BY channels.updated_at DESC, channels.id ASC
					LIMIT 1
				) AS selected
				WHERE user_projects.user_id = ${userId}
					AND user_projects.repository_id IN (
						SELECT value
						FROM jsonb_array_elements_text(${JSON.stringify(repositoryIds)}::text::jsonb)
					)
				ORDER BY user_projects.position ASC
				LIMIT 1
			`;
			return found?.id;
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
		this.#run("save navigation", () =>
			this.#sql.begin(async transaction => {
				if (documentId) await this.#requireActiveDocument(transaction, documentId);
				return this.#saveNavigation(transaction, userId, documentId, now);
			}));

	readonly setLastDocumentIfCurrent = (
		userId: string,
		expectedRevision: number | undefined,
		documentId: string | undefined,
		now: Date,
	): Promise<CompareNavigationResult> =>
		this.#run("compare and save navigation", () =>
			this.#sql.begin(async transaction => {
				if (documentId) await this.#requireActiveDocument(transaction, documentId);
				let saved: NavigationRow | undefined;
				if (expectedRevision === undefined) {
					[saved] = await transaction<NavigationRow[]>`
						INSERT INTO user_navigation (user_id, last_document_id, revision, updated_at)
						VALUES (${userId}, ${documentId ?? null}, 0, ${now})
						ON CONFLICT (user_id) DO NOTHING
						RETURNING ${transaction.unsafe(NAVIGATION_COLUMNS)}
					`;
				} else {
					[saved] = await transaction<NavigationRow[]>`
						UPDATE user_navigation SET
							last_document_id = ${documentId ?? null},
							revision = revision + 1,
							updated_at = ${now}
						WHERE user_id = ${userId} AND revision = ${expectedRevision}
						RETURNING ${transaction.unsafe(NAVIGATION_COLUMNS)}
					`;
				}
				if (saved) return { navigation: navigation(saved), updated: true };
				let [current] = await transaction<NavigationRow[]>`
					SELECT ${transaction.unsafe(NAVIGATION_COLUMNS)}
					FROM user_navigation WHERE user_id = ${userId}
				`;
				if (!current) throw conflict(`navigation for user ${userId} changed`);
				return { navigation: navigation(current), updated: false };
			}));

	readonly recordVisit = (input: RecordNavigationVisit): Promise<UserNavigation> =>
		this.#run("record navigation visit", () =>
			this.#sql.begin(async transaction => {
				let existing = await this.#saveExistingVisit(transaction, input);
				if (existing) return existing;
				await this.#requireDocument(transaction, input.documentId, input.repositoryId);
				await this.#addProject(transaction, input);
				return this.#saveNavigation(transaction, input.userId, input.documentId, input.now);
			}));

	async #saveExistingVisit(
		transaction: TransactionSQL,
		input: RecordNavigationVisit,
	): Promise<UserNavigation | undefined> {
		let [saved] = await transaction<NavigationRow[]>`
			INSERT INTO user_navigation (user_id, last_document_id, revision, updated_at)
			SELECT user_projects.user_id, channels.id, 0, ${input.now}
			FROM user_projects
			JOIN channels
				ON channels.id = ${input.documentId}
				AND channels.repository_id = user_projects.repository_id
				AND channels.archived_at IS NULL
			WHERE user_projects.user_id = ${input.userId}
				AND user_projects.repository_id = ${input.repositoryId}
			ON CONFLICT (user_id) DO UPDATE SET
				last_document_id = EXCLUDED.last_document_id,
				revision = user_navigation.revision + 1,
				updated_at = EXCLUDED.updated_at
			RETURNING ${transaction.unsafe(NAVIGATION_COLUMNS)}
		`;
		return saved ? navigation(saved) : undefined;
	}

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
			INSERT INTO user_navigation (user_id, last_document_id, revision, updated_at)
			VALUES (${userId}, ${documentId ?? null}, 0, ${now})
			ON CONFLICT (user_id) DO UPDATE SET
				last_document_id = EXCLUDED.last_document_id,
				revision = user_navigation.revision + 1,
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
		await this.#requireActiveDocument(transaction, documentId, repositoryId);
	}

	async #requireActiveDocument(
		transaction: TransactionSQL,
		documentId: string,
		repositoryId?: string,
	): Promise<void> {
		let [found] = await transaction<{ archivedAt: Timestamp | null }[]>`
			SELECT archived_at AS "archivedAt" FROM channels
			WHERE id = ${documentId}
				AND (${repositoryId === undefined} OR repository_id = ${repositoryId ?? ""})
			FOR KEY SHARE
		`;
		if (!found) {
			let suffix = repositoryId ? ` in repository ${repositoryId}` : "";
			throw missing(`channel ${documentId} does not exist${suffix}`);
		}
		if (found.archivedAt !== null) throw conflict(`channel ${documentId} is archived`);
	}
}
