import { SQL } from "bun";

import { quotedIdentifier as id, quotedLiteral, scramVerifier } from "./names";

import type { MachineStoreConfig } from "./config";

export class MachineStoreRefusal extends Error {
	override name = "MachineStoreRefusal";
}

export interface MachineStoreServer {
	loginUrl(role: string): string;
	provision(role: string, password: string): Promise<void>;
	setPassword(role: string, password: string): Promise<void>;
	accepts(role: string, password: string): Promise<boolean | undefined>;
	disable(role: string): Promise<void>;
	drop(role: string): Promise<void>;
	close(): Promise<void>;
}

export const ATOMIC_SCHEMA = "atomic";
/** The administrator's schema for extensions: an extension's script runs with elevated rights. */
export const EXTENSION_SCHEMA = "extensions";
export const MANAGED_ROLE_MARK = "chopin:machine-store";
export const MANAGED_DATABASE_MARK = MANAGED_ROLE_MARK;
export const CREATING_DATABASE_MARK = `${MANAGED_ROLE_MARK}:creating-database`;
const ROLE_MARKS = [MANAGED_ROLE_MARK, CREATING_DATABASE_MARK];
const UNREACHABLE_DATABASES = ["postgres", "template1"];
const REASON_CHARS = 280;

type Me = { name: string; superuser: boolean; database: string };
type ServerError = { errno?: unknown; code?: unknown; message?: unknown };

function serverCode(error: unknown): string | undefined {
	let errno = (error as ServerError | undefined)?.errno;
	return typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno) ? errno : undefined;
}

function shortened(text: string) {
	let line = text.replace(/\s+/g, " ").trim();
	return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line;
}

export class PostgresMachineStoreServer implements MachineStoreServer {
	readonly #base: URL;
	readonly #password: string | undefined;
	readonly #admin: SQL;
	readonly #unreachable: readonly string[];
	readonly #open: ReadonlySet<string>;

	constructor(config: MachineStoreConfig, unreachable: readonly string[] = UNREACHABLE_DATABASES) {
		this.#base = new URL(config.url);
		this.#password = config.password;
		this.#unreachable = unreachable;
		this.#open = new Set(config.openDatabases);
		this.#admin = new SQL({
			url: this.#base.href,
			...(config.password ? { password: config.password } : {}),
			max: 2,
			idleTimeout: 30,
			connectionTimeout: 10,
		});
	}

	get #where() {
		return `${this.#base.hostname}:${this.#base.port || "5432"}`;
	}

	loginUrl(role: string): string {
		let url = new URL(`postgresql://${this.#base.host}`);
		url.username = role;
		url.pathname = `/${role}`;
		let mode = this.#base.searchParams.get("sslmode");
		if (mode) url.searchParams.set("sslmode", mode);
		return url.href;
	}

	#urlOf(database: string) {
		let url = new URL(this.#base.href);
		url.pathname = `/${encodeURIComponent(database)}`;
		return url.href;
	}

	async provision(role: string, password: string): Promise<void> {
		await this.#refusing(async () => {
			let me = await this.#me();
			await this.#checkOpen(role, me);
			let [existing] = await this.#admin<{ name: string }[]>`
				SELECT rolname AS name FROM pg_roles WHERE rolname = ${role}
			`;
			if (existing) await this.#checkRole(role);
			else {
				await this.#admin.begin(async transaction => {
					await transaction.unsafe(
						`CREATE ROLE ${id(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION `
							+ "NOBYPASSRLS NOINHERIT",
					);
					await transaction.unsafe(
						`COMMENT ON ROLE ${id(role)} IS ${quotedLiteral(MANAGED_ROLE_MARK)}`,
					);
				});
			}
			if (!me.superuser) {
				await this.#admin.unsafe(`GRANT ${id(role)} TO CURRENT_USER`).catch(() => {});
			}
			await this.#database(role, me);
			await this.#closeOthers(role, me);
			await this.#checkRole(role);
			await this.#admin.unsafe(
				`ALTER ROLE ${id(role)} WITH LOGIN PASSWORD ${quotedLiteral(scramVerifier(password))}`,
			);
			await this.#checkConnections(role, password, me);
		});
	}

	async setPassword(role: string, password: string): Promise<void> {
		await this.#refusing(async () => {
			let me = await this.#me();
			await this.#checkRole(role);
			await this.#checkDatabase(role, me);
			await this.#admin.unsafe(
				`ALTER ROLE ${id(role)} WITH PASSWORD ${quotedLiteral(scramVerifier(password))}`,
			);
			await this.#terminate(role);
		});
	}

	async accepts(role: string, password: string): Promise<boolean | undefined> {
		try {
			await this.#connectAs(role, password, role);
			return true;
		} catch (error) {
			let code = serverCode(error);
			let message = String((error as ServerError | undefined)?.message);
			return code === "28P01" || (code === "28000" && message.includes("not permitted to log in"))
				? false
				: undefined;
		}
	}

	async disable(role: string): Promise<void> {
		await this.#refusing(async () => {
			let me = await this.#me();
			if (await this.#managedRole(role)) {
				await this.#admin.unsafe(`ALTER ROLE ${id(role)} NOLOGIN`);
				await this.#terminate(role);
			}
			if (await this.#managedDatabase(role, me)) {
				await this.#admin.unsafe(`ALTER DATABASE ${id(role)} ALLOW_CONNECTIONS false`);
			}
		});
	}

	async drop(role: string): Promise<void> {
		await this.disable(role);
		await this.#refusing(async () => {
			let me = await this.#me();
			if (await this.#managedDatabase(role, me)) {
				await this.#admin.unsafe(`DROP DATABASE IF EXISTS ${id(role)} WITH (FORCE)`);
			}
			if (await this.#managedRole(role)) {
				await this.#admin.unsafe(`DROP ROLE IF EXISTS ${id(role)}`);
			}
		});
	}

	async close(): Promise<void> {
		await this.#admin.close();
	}

	async #me(): Promise<Me> {
		let [me] = await this.#admin<Me[]>`
			SELECT current_user AS name, rolsuper AS superuser, current_database() AS database
			FROM pg_roles WHERE rolname = current_user
		`;
		if (!me) throw new MachineStoreRefusal("the administrator role can't read its own attributes");
		return me;
	}

	async #managedRole(role: string) {
		let rows = await this.#admin`
			SELECT 1 FROM pg_roles
			WHERE rolname = ${role} AND shobj_description(oid, 'pg_authid') IN ${this.#admin(ROLE_MARKS)}
		`;
		return rows.length > 0;
	}

	async #databaseOf(role: string) {
		let [found] = await this.#admin<
			{ owner: string; open: boolean; marked: boolean; creating: boolean }[]
		>`
			SELECT pg_get_userbyid(d.datdba) AS owner, d.datallowconn AS open,
				coalesce(shobj_description(d.oid, 'pg_database') = ${MANAGED_DATABASE_MARK}, false) AS marked,
				coalesce((
					SELECT shobj_description(r.oid, 'pg_authid') = ${CREATING_DATABASE_MARK}
					FROM pg_roles r WHERE r.rolname = d.datname
				), false) AS creating
			FROM pg_database d WHERE d.datname = ${role}
		`;
		return found;
	}

	async #managedDatabase(database: string, me: Me) {
		let found = await this.#databaseOf(database);
		return !!found && found.owner === me.name && (found.marked || found.creating);
	}

	async #database(role: string, me: Me) {
		let found = await this.#databaseOf(role);
		if (!found) {
			await this.#admin.unsafe(
				`COMMENT ON ROLE ${id(role)} IS ${quotedLiteral(CREATING_DATABASE_MARK)}`,
			);
			await this.#admin.unsafe(`CREATE DATABASE ${id(role)} ALLOW_CONNECTIONS false`);
			found = { owner: me.name, open: false, marked: false, creating: true };
		}
		if (found.owner !== me.name) {
			throw new MachineStoreRefusal(
				`the database ${role} belongs to ${found.owner}, not to ${me.name}, so Chopin won't use it`,
			);
		}
		if (!found.marked && !found.creating) {
			throw new MachineStoreRefusal(
				`the existing database ${role} wasn't made by Chopin, so Chopin won't use it`,
			);
		}
		if (found.open) await this.#admin.unsafe(`ALTER DATABASE ${id(role)} ALLOW_CONNECTIONS false`);
		if (!found.marked) {
			await this.#admin.unsafe(
				`COMMENT ON DATABASE ${id(role)} IS ${quotedLiteral(MANAGED_DATABASE_MARK)}`,
			);
		}
		if (found.creating) {
			await this.#admin.unsafe(
				`COMMENT ON ROLE ${id(role)} IS ${quotedLiteral(MANAGED_ROLE_MARK)}`,
			);
		}
		await this.#admin.unsafe(`REVOKE ALL ON DATABASE ${id(role)} FROM PUBLIC`);
		let grantees = await this.#admin<{ grantee: string }[]>`
			SELECT DISTINCT pg_get_userbyid(a.grantee) AS grantee
			FROM pg_database d, aclexplode(d.datacl) a
			WHERE d.datname = ${role} AND a.grantee <> 0 AND a.grantee <> d.datdba
		`;
		for (let { grantee } of grantees) {
			if (grantee !== role) {
				await this.#admin.unsafe(`REVOKE ALL ON DATABASE ${id(role)} FROM ${id(grantee)}`);
			}
		}
		await this.#admin.unsafe(`REVOKE ALL ON DATABASE ${id(role)} FROM ${id(role)}`);
		await this.#admin.unsafe(`GRANT CONNECT ON DATABASE ${id(role)} TO ${id(role)}`);
		await this.#checkDatabase(role, me);
		await this.#admin.unsafe(`ALTER DATABASE ${id(role)} ALLOW_CONNECTIONS true`);
		let inside = new SQL({
			url: this.#urlOf(role),
			...(this.#password ? { password: this.#password } : {}),
			max: 1,
			connectionTimeout: 10,
		});
		try {
			await inside.unsafe("REVOKE ALL ON SCHEMA public FROM PUBLIC");
			await inside.unsafe(
				`CREATE SCHEMA IF NOT EXISTS ${id(ATOMIC_SCHEMA)} AUTHORIZATION ${id(role)}`,
			);
			let [schema] = await inside<{ owner: string }[]>`
				SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${ATOMIC_SCHEMA}
			`;
			if (schema?.owner !== role) {
				throw new MachineStoreRefusal(
					`the schema ${ATOMIC_SCHEMA} in ${role} belongs to ${schema?.owner ?? "nobody"}`,
				);
			}
			// The role can't create pg_trgm, which Atomic's session search indexes with, and its script
			// runs with elevated rights, so only in a schema the administrator alone can write.
			await inside.unsafe(`CREATE SCHEMA IF NOT EXISTS ${id(EXTENSION_SCHEMA)}`);
			let [extensions] = await inside<{ ours: boolean }[]>`
				SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND NOT EXISTS (
					SELECT 1 FROM aclexplode(nspacl) a WHERE a.privilege_type = 'CREATE' AND a.grantee <> nspowner
				) AS ours
				FROM pg_namespace WHERE nspname = ${EXTENSION_SCHEMA}
			`;
			if (extensions?.ours) {
				await inside.unsafe(`GRANT USAGE ON SCHEMA ${id(EXTENSION_SCHEMA)} TO ${id(role)}`);
				await inside.unsafe(
					`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA ${id(EXTENSION_SCHEMA)}`,
				).catch(error => {
					console.warn(
						`chopin: Atomic's session search in ${role} runs without its index, as pg_trgm can't be `
							+ "added -",
						this.#reason(error),
					);
				});
			}
		} finally {
			await inside.close();
		}
	}

	async #checkDatabase(role: string, me: Me) {
		let [found] = await this.#admin<
			{ owner: string; marked: boolean; others: number; widened: number }[]
		>`
			SELECT pg_get_userbyid(d.datdba) AS owner,
				coalesce(shobj_description(d.oid, 'pg_database') = ${MANAGED_DATABASE_MARK}, false) AS marked,
				(SELECT count(*)::int FROM aclexplode(d.datacl) a
					WHERE a.grantee <> d.datdba AND a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = ${role})
				) AS others,
				(SELECT count(*)::int FROM aclexplode(d.datacl) a
					WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = ${role})
						AND (a.privilege_type <> 'CONNECT' OR a.is_grantable)
				) AS widened
			FROM pg_database d WHERE d.datname = ${role}
		`;
		if (!found) throw new MachineStoreRefusal(`the database ${role} doesn't exist`);
		if (found.owner !== me.name) {
			throw new MachineStoreRefusal(
				`the database ${role} belongs to ${found.owner}, not to ${me.name}, so Chopin won't use it`,
			);
		}
		if (!found.marked) {
			throw new MachineStoreRefusal(
				`the existing database ${role} wasn't made by Chopin, so Chopin won't use it`,
			);
		}
		if (found.others > 0) {
			throw new MachineStoreRefusal(`other roles have privileges on the database ${role}`);
		}
		if (found.widened > 0) {
			throw new MachineStoreRefusal(
				`the role ${role} has more than CONNECT on its database, or may grant it to others`,
			);
		}
	}

	/**
	 * Revoke `CONNECT` from `PUBLIC` on every other database the role could connect to, and refuse
	 * the login while any still lets it: a `REVOKE` by an administrator that may not grant `CONNECT`
	 * there (it doesn't own the database) only warns and leaves it.
	 */
	async #closeOthers(role: string, me: Me) {
		for (let name of await this.#reachable(role)) {
			await this.#admin.unsafe(`REVOKE CONNECT ON DATABASE ${id(name)} FROM PUBLIC`);
		}
		let open = await this.#reachable(role);
		if (open.length) {
			let named = open.length > 2
				? `databases ${open.slice(0, 2).join(", ")} and ${open.length - 2} more`
				: `database${open.length > 1 ? "s" : ""} ${open.join(" and ")}`;
			let they = open.length > 1 ? "them" : "it";
			throw new MachineStoreRefusal(
				`${me.name} can't revoke CONNECT from PUBLIC on the ${named}, so a machine could connect `
					+ `there; ${open.length > 1 ? "their owners" : "its owner"} must revoke it, or name `
					+ `${they} in MACHINE_STORE_OPEN_DATABASES if the service keeps ${they} open to every role`,
			);
		}
	}

	/** Refuse an open database that is a machine's or the administrator's own. */
	async #checkOpen(role: string, me: Me) {
		if (!this.#open.size) return;
		let wrong = await this.#admin<{ name: string }[]>`
			SELECT datname AS name FROM pg_database
			WHERE datname IN ${this.#admin([...this.#open])} AND (
				datname IN ${this.#admin([role, me.database])}
				OR coalesce(shobj_description(oid, 'pg_database') IN ${this.#admin(ROLE_MARKS)}, false)
			)
			ORDER BY datname
		`;
		if (wrong.length) {
			throw new MachineStoreRefusal(
				`MACHINE_STORE_OPEN_DATABASES names ${wrong.map(row => row.name).join(" and ")}, `
					+ "a machine's or the administrator's own database, which machines must not share",
			);
		}
	}

	/**
	 * The connectable databases, other than its own and those the service keeps open to every role,
	 * the role has `CONNECT` on.
	 */
	async #reachable(role: string) {
		let rows = await this.#admin<{ name: string }[]>`
			SELECT datname AS name FROM pg_database
			WHERE datallowconn AND datname <> ${role} AND has_database_privilege(
				(SELECT oid FROM pg_roles WHERE rolname = ${role}), oid, 'CONNECT'
			)
			ORDER BY datname
		`;
		return rows.map(row => row.name).filter(name => !this.#open.has(name));
	}

	async #checkRole(role: string) {
		let [found] = await this.#admin<
			{
				superuser: boolean;
				createRole: boolean;
				createDatabase: boolean;
				replication: boolean;
				bypassRls: boolean;
				marked: boolean;
				memberships: number;
				members: number;
				owned: number;
				granted: number;
			}[]
		>`
			SELECT r.rolsuper AS superuser, r.rolcreaterole AS "createRole", r.rolcreatedb AS "createDatabase",
				r.rolreplication AS replication, r.rolbypassrls AS "bypassRls",
				coalesce(shobj_description(r.oid, 'pg_authid') IN ${
			this.#admin(ROLE_MARKS)
		}, false) AS marked,
				(SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
				(SELECT count(*)::int FROM pg_auth_members m
					WHERE m.roleid = r.oid AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
				) AS members,
				(SELECT count(*)::int FROM pg_database d WHERE d.datdba = r.oid) AS owned,
				(SELECT count(*)::int FROM pg_database d, aclexplode(d.datacl) a
					WHERE a.grantee = r.oid AND d.datname <> r.rolname) AS granted
			FROM pg_roles r WHERE r.rolname = ${role}
		`;
		if (!found) throw new MachineStoreRefusal(`the role ${role} doesn't exist`);
		let problems = [
			found.superuser && "is a superuser",
			found.createRole && "can create roles",
			found.createDatabase && "can create databases",
			found.replication && "can replicate",
			found.bypassRls && "bypasses row security",
			!found.marked && "wasn't made by Chopin",
			found.memberships > 0 && "is a member of another role",
			found.members > 0 && "has other roles as members",
			found.owned > 0 && "owns a database",
			found.granted > 0 && "has privileges on another database",
		].filter(Boolean);
		if (problems.length) {
			throw new MachineStoreRefusal(
				`the existing role ${role} ${problems.join(", ")}, so Chopin won't use it`,
			);
		}
	}

	async #checkConnections(role: string, password: string, me: Me) {
		try {
			let [who] = await this.#connectAs(role, password, role);
			if (who?.name !== role) {
				throw new MachineStoreRefusal(`a login as ${role} became ${who?.name}`);
			}
		} catch (error) {
			await this.#admin.unsafe(`ALTER ROLE ${id(role)} NOLOGIN`).catch(() => {});
			if (error instanceof MachineStoreRefusal) throw error;
			throw new MachineStoreRefusal(
				`the machine couldn't connect to its own database: ${this.#reason(error)}`,
			);
		}
		// Every connectable database but the machines' own, which the administrator owns and closed
		// itself: probing those would cost a connection per paired machine.
		let others = await this.#admin<{ name: string }[]>`
			SELECT datname AS name FROM pg_database
			WHERE datallowconn AND datname <> ${role} AND NOT (
				datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
				AND coalesce(shobj_description(oid, 'pg_database') = ${MANAGED_DATABASE_MARK}, false)
			)
			ORDER BY datname
		`;
		let probed = new Set([...this.#unreachable, me.database, ...others.map(other => other.name)]);
		for (let name of this.#open) probed.delete(name);
		for (let database of probed) {
			let reached = await this.#connectAs(role, password, database).then(() => true, () => false);
			if (reached) {
				await this.#admin.unsafe(`ALTER ROLE ${id(role)} NOLOGIN`).catch(() => {});
				throw new MachineStoreRefusal(
					`a machine could still connect to the database ${database}; revoke CONNECT on it `
						+ "from PUBLIC as its owner",
				);
			}
		}
	}

	async #connectAs(role: string, password: string, database: string) {
		let sql = new SQL({
			url: this.#urlOf(database),
			username: role,
			password,
			max: 1,
			connectionTimeout: 10,
		});
		try {
			return await sql<{ name: string }[]>`SELECT current_user AS name`;
		} finally {
			await sql.close().catch(() => {});
		}
	}

	async #terminate(role: string) {
		await this.#admin`
			SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${role}
		`.catch(() => {});
	}

	async #refusing(action: () => Promise<void>) {
		try {
			await action();
		} catch (error) {
			if (error instanceof MachineStoreRefusal) throw error;
			throw new MachineStoreRefusal(this.#reason(error));
		}
	}

	#reason(error: unknown): string {
		let code = serverCode(error);
		let message = (error as ServerError | undefined)?.message;
		if (code) {
			return shortened(
				`the database server at ${this.#where} refused (${code})${
					typeof message === "string" ? `: ${message}` : ""
				}`,
			);
		}
		let kind = (error as ServerError | undefined)?.code;
		return `Chopin couldn't reach the database server at ${this.#where}${
			typeof kind === "string" && /^[A-Z_]+$/.test(kind) ? ` (${kind})` : ""
		}`;
	}
}
