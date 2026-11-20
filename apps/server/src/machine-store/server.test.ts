import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";
import { StorageProvider } from "@bastani/atomic/storage";
import { Machines } from "../auth/machines";
import { testLease } from "../storage/contract-support";
import { machine, owner } from "../storage/machine-contract";
import { MemoryStorage } from "../storage/memory/adapter";
import { machineStoreName, newStorePassword } from "./names";
import { MachineStores } from "./service";
import {
	CREATING_DATABASE_MARK,
	MachineStoreRefusal,
	MANAGED_ROLE_MARK,
	PostgresMachineStoreServer,
} from "./server";

import type { AddressInfo } from "node:net";
import type { StorageOpenContext } from "@bastani/atomic/storage";

let database = process.env.TEST_DATABASE_URL;

function administrator(target: string) {
	let url = new URL(target);
	let password = decodeURIComponent(url.password);
	url.password = "";
	return { url: url.href, ...(password ? { password } : {}) };
}

async function recordingProxy(target: string) {
	let destination = new URL(target);
	let sent: Buffer[] = [];
	let server = createServer(client => {
		let upstream = connect(Number(destination.port || 5432), destination.hostname);
		client.on("error", () => upstream.destroy());
		upstream.on("error", () => client.destroy());
		client.on("data", chunk => {
			sent.push(Buffer.from(chunk));
			upstream.write(chunk);
		});
		upstream.on("data", chunk => client.write(chunk));
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	let url = new URL(target);
	url.hostname = "127.0.0.1";
	url.port = String((server.address() as AddressInfo).port);
	return {
		url: url.href,
		sent: () => Buffer.concat(sent).toString("latin1"),
		close: () => new Promise<void>(done => server.close(() => done())),
	};
}

function refusedCode(promise: Promise<unknown>) {
	return promise.then(
		() => "connected",
		(error: { errno?: string }) => error.errno ?? "error",
	);
}

if (!database) {
	test.skip("machine store logins need TEST_DATABASE_URL", () => {});
} else {
	let admin = administrator(database);
	let sql = new SQL({ url: database, max: 2 });
	let server = new PostgresMachineStoreServer(admin);
	let roles: string[] = [];
	let newRole = () => {
		let role = machineStoreName(crypto.randomUUID());
		roles.push(role);
		return role;
	};
	let connectAs = async (role: string, password: string, name: string) => {
		let url = new URL(database!);
		url.pathname = `/${name}`;
		let client = new SQL({ url: url.href, username: role, password, max: 1, connectionTimeout: 5 });
		try {
			let [row] = await client<{ name: string }[]>`SELECT current_user AS name`;
			return row!.name;
		} finally {
			await client.close().catch(() => {});
		}
	};
	let asRole = (role: string, password: string, name = role) => {
		let url = new URL(database!);
		url.pathname = `/${name}`;
		return new SQL({ url: url.href, username: role, password, max: 1, connectionTimeout: 5 });
	};

	afterAll(async () => {
		for (let role of roles) {
			await server.drop(role).catch(() => {});
			await sql.unsafe(`DROP DATABASE IF EXISTS "${role}" WITH (FORCE)`).catch(() => {});
			await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
		}
		let [own] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
		for (let name of ["postgres", "template1", own!.name]) {
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO PUBLIC`).catch(() => {});
		}
		await server.close();
		await sql.close();
	});

	describe("a machine's database login on PostgreSQL", () => {
		test("connects to the machine's own database and to no other", async () => {
			let role = newRole();
			let other = newRole();
			let password = newStorePassword();
			let otherPassword = newStorePassword();
			await server.provision(role, password);
			await server.provision(other, otherPassword);
			expect(await connectAs(role, password, role)).toBe(role);
			let [own] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
			for (let name of ["postgres", "template1", own!.name, other]) {
				expect(await refusedCode(connectAs(role, password, name))).toBe("42501");
			}
			expect(await refusedCode(connectAs(other, otherPassword, role))).toBe("42501");
			expect(await refusedCode(connectAs(other, password, other))).toBe("28P01");
			expect(server.loginUrl(role)).toContain(`${role}@`);
			expect(new URL(server.loginUrl(role)).password).toBe("");
		});

		test("can't create roles or databases, own its database, or let anyone else in", async () => {
			let role = newRole();
			let other = newRole();
			let password = newStorePassword();
			let otherPassword = newStorePassword();
			await server.provision(role, password);
			await server.provision(other, otherPassword);
			let [attributes] = await sql<Record<string, boolean>[]>`
				SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin
				FROM pg_roles WHERE rolname = ${role}
			`;
			expect(attributes).toEqual({
				rolsuper: false,
				rolcreaterole: false,
				rolcreatedb: false,
				rolreplication: false,
				rolbypassrls: false,
				rolcanlogin: true,
			});
			let [owner] = await sql<{ owner: string; me: string }[]>`
				SELECT pg_get_userbyid(datdba) AS owner, current_user AS me FROM pg_database
				WHERE datname = ${role}
			`;
			expect(owner!.owner).toBe(owner!.me);
			let [owned] = await sql<{ count: number }[]>`
				SELECT count(*)::int AS count FROM pg_database WHERE pg_get_userbyid(datdba) = ${role}
			`;
			expect(owned!.count).toBe(0);
			let client = asRole(role, password);
			try {
				expect(await refusedCode(client.unsafe(`CREATE ROLE "${role}_x"`))).toBe("42501");
				expect(await refusedCode(client.unsafe(`CREATE DATABASE "${role}_x"`))).toBe("42501");
				let [before] = await sql<{ acl: string }[]>`
					SELECT datacl::text AS acl FROM pg_database WHERE datname = ${role}
				`;
				await client.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO "${other}"`).catch(() => {});
				await client.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO PUBLIC`).catch(() => {});
				let [after] = await sql<{ acl: string }[]>`
					SELECT datacl::text AS acl FROM pg_database WHERE datname = ${role}
				`;
				expect(after).toEqual(before!);
				expect(await refusedCode(connectAs(other, otherPassword, role))).toBe("42501");
				expect(await refusedCode(client.unsafe("CREATE TABLE public.kept (id int)"))).toBe("42501");
			} finally {
				await client.close();
			}
		});

		test("opens Atomic's sessions as the machine's role, its tables in its own schema", async () => {
			let role = newRole();
			let password = newStorePassword();
			await server.provision(role, password);
			let db = await openPostgresDatabase({
				url: server.loginUrl(role),
				password,
				maxConnections: 2,
			});
			let agentDir = mkdtempSync(join(tmpdir(), "machine-store-atomic-"));
			try {
				let context = { agentDir, domain: "sessions" } as StorageOpenContext;
				let store = await new StorageProvider().openSessionStore(
					{ kind: "database", database: db },
					context,
				);
				await (store as { close?: () => Promise<void> }).close?.();
				let client0 = asRole(role, password);
				let tables = await client0<{ owner: string }[]>`
					SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'atomic'
				`;
				let trigrams = await client0<{ name: string }[]>`
					SELECT indexname AS name FROM pg_indexes
					WHERE schemaname = 'atomic' AND indexdef LIKE '%extensions.gin_trgm_ops%'
				`;
				expect(trigrams.length).toBeGreaterThan(0);
				expect(
					await refusedCode(
						client0.unsafe("CREATE FUNCTION extensions.f() RETURNS int AS 'SELECT 1' LANGUAGE sql"),
					),
				)
					.toBe("42501");
				await client0.close();
				let client = asRole(role, password);
				try {
					let [count] = await client<{ count: number }[]>`
						SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'atomic'
					`;
					expect(count!.count).toBeGreaterThan(0);
				} finally {
					await client.close();
				}
				expect([...tables]).toEqual([{ owner: role }]);
			} finally {
				await db.close();
				rmSync(agentDir, { recursive: true, force: true });
			}
		});

		test("returns the same login on every provision and only a rotation changes it", async () => {
			let role = newRole();
			let first = newStorePassword();
			await server.provision(role, first);
			await server.provision(role, first);
			expect(await server.accepts(role, first)).toBe(true);
			let open = asRole(role, first);
			await open`SELECT 1`;
			let second = newStorePassword();
			await server.setPassword(role, second);
			expect(await server.accepts(role, first)).toBe(false);
			expect(await server.accepts(role, second)).toBe(true);
			expect(await refusedCode(open`SELECT 1`)).not.toBe("connected");
			await open.close().catch(() => {});
		});

		test("finishes a partly made database before anyone can connect to it", async () => {
			let role = newRole();
			let other = newRole();
			let otherPassword = newStorePassword();
			await server.provision(other, otherPassword);
			await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
			await sql.unsafe(`COMMENT ON ROLE "${role}" IS '${CREATING_DATABASE_MARK}'`);
			await sql.unsafe(`CREATE DATABASE "${role}" ALLOW_CONNECTIONS false`);
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO PUBLIC`);
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO "${other}"`);
			expect(await refusedCode(connectAs(other, otherPassword, role))).not.toBe("connected");
			let password = newStorePassword();
			await server.provision(role, password);
			expect(await connectAs(role, password, role)).toBe(role);
			expect(await refusedCode(connectAs(other, otherPassword, role))).toBe("42501");
			let [acl] = await sql<{ acl: string }[]>`
				SELECT datacl::text AS acl FROM pg_database WHERE datname = ${role}
			`;
			expect(acl!.acl).not.toContain(other);
			expect(acl!.acl).not.toMatch(/[{,]=/);
			let [marks] = await sql<{ role: string; database: string }[]>`
				SELECT shobj_description(r.oid, 'pg_authid') AS role,
					shobj_description(d.oid, 'pg_database') AS database
				FROM pg_roles r JOIN pg_database d ON d.datname = r.rolname WHERE r.rolname = ${role}
			`;
			expect(marks).toEqual({ role: MANAGED_ROLE_MARK, database: MANAGED_ROLE_MARK });
		});

		test("leaves an administrator's database it didn't make alone, even under a machine's name", async () => {
			let role = newRole();
			let password = newStorePassword();
			await sql.unsafe(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
			await sql.unsafe(`COMMENT ON ROLE "${role}" IS '${MANAGED_ROLE_MARK}'`);
			await sql.unsafe(`CREATE DATABASE "${role}"`);
			let read = async () => {
				let [found] = await sql<{ open: boolean; acl: string | null; comment: string | null }[]>`
					SELECT datallowconn AS open, datacl::text AS acl,
						shobj_description(oid, 'pg_database') AS comment
					FROM pg_database WHERE datname = ${role}
				`;
				return found;
			};
			let before = await read();
			await expect(server.provision(role, password)).rejects.toThrow("wasn't made by Chopin");
			await expect(server.setPassword(role, password)).rejects.toThrow("wasn't made by Chopin");
			await server.disable(role);
			await server.drop(role);
			expect(await read()).toEqual(before!);
			let [login] = await sql<{ login: boolean }[]>`
				SELECT rolcanlogin AS login FROM pg_roles WHERE rolname = ${role}
			`;
			expect(login?.login ?? false).toBe(false);
		});

		test("rotates no login whose database lets its role grant CONNECT onward", async () => {
			let role = newRole();
			let other = newRole();
			let password = newStorePassword();
			let otherPassword = newStorePassword();
			await server.provision(role, password);
			await server.provision(other, otherPassword);
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO "${role}" WITH GRANT OPTION`);
			let next = newStorePassword();
			await expect(server.setPassword(role, next)).rejects.toThrow("may grant it to others");
			expect(await server.accepts(role, next)).toBe(false);
			await sql.unsafe(`REVOKE GRANT OPTION FOR CONNECT ON DATABASE "${role}" FROM "${role}"`);
			await sql.unsafe(`GRANT TEMPORARY ON DATABASE "${role}" TO "${role}"`);
			await expect(server.setPassword(role, next)).rejects.toThrow("more than CONNECT");
			await server.provision(role, password);
			await server.setPassword(role, next);
			let client = asRole(role, next);
			try {
				await client.unsafe(`GRANT CONNECT ON DATABASE "${role}" TO "${other}"`).catch(() => {});
			} finally {
				await client.close();
			}
			expect(await refusedCode(connectAs(other, otherPassword, role))).toBe("42501");
		});

		test("refuses a role or database that isn't the managed one, and never enables its login", async () => {
			let privileged = newRole();
			await sql.unsafe(`CREATE ROLE "${privileged}" NOLOGIN CREATEDB`);
			await expect(server.provision(privileged, newStorePassword())).rejects.toThrow(
				"can create databases",
			);
			let member = newRole();
			let group = `${member}_group`;
			await sql.unsafe(`CREATE ROLE "${group}" NOLOGIN`);
			await sql.unsafe(`CREATE ROLE "${member}" NOLOGIN IN ROLE "${group}"`);
			await expect(server.provision(member, newStorePassword())).rejects.toThrow(
				"is a member of another role",
			);
			let elsewhere = newRole();
			let [own] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
			await sql.unsafe(`CREATE ROLE "${elsewhere}" NOLOGIN`);
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${own!.name}" TO "${elsewhere}"`);
			await expect(server.provision(elsewhere, newStorePassword())).rejects.toThrow(
				"has privileges on another database",
			);
			await sql.unsafe(`REVOKE CONNECT ON DATABASE "${own!.name}" FROM "${elsewhere}"`);
			let foreign = newRole();
			await sql.unsafe(`CREATE ROLE "${foreign}" NOLOGIN`);
			await sql.unsafe(`CREATE DATABASE "${foreign}" OWNER "${foreign}"`);
			let refusal = await server.provision(foreign, newStorePassword()).catch(error => error);
			expect(refusal).toBeInstanceOf(MachineStoreRefusal);
			let logins = await sql<{ name: string }[]>`
				SELECT rolname AS name FROM pg_roles
				WHERE rolname IN ${sql([privileged, member, elsewhere, foreign])} AND rolcanlogin
			`;
			expect([...logins]).toEqual([]);
			await sql.unsafe(`DROP ROLE "${group}"`).catch(() => {});
		});

		test("refuses a login other roles are members of, as they would share its access", async () => {
			let role = newRole();
			let reader = newRole();
			let password = newStorePassword();
			let readerPassword = newStorePassword();
			await server.provision(role, password);
			await sql.unsafe(
				`CREATE ROLE "${reader}" LOGIN PASSWORD '${readerPassword}' IN ROLE "${role}"`,
			);
			await expect(server.provision(role, password)).rejects.toThrow("has other roles as members");
			await expect(server.setPassword(role, newStorePassword())).rejects.toThrow(
				"has other roles as members",
			);
			expect(await server.accepts(role, password)).toBe(true);
		});

		test("refuses an unmarked role, and leaves a foreign role and database alone when cleaning up", async () => {
			let foreign = newRole();
			let foreignPassword = newStorePassword();
			await sql.unsafe(`CREATE ROLE "${foreign}" LOGIN PASSWORD '${foreignPassword}'`);
			await sql.unsafe(`CREATE DATABASE "${foreign}" OWNER "${foreign}"`);
			await expect(server.provision(foreign, newStorePassword())).rejects.toThrow(
				"wasn't made by Chopin",
			);
			await server.disable(foreign);
			await server.drop(foreign);
			let [kept] = await sql<{ login: boolean; open: boolean; owner: string }[]>`
				SELECT r.rolcanlogin AS login, d.datallowconn AS open, pg_get_userbyid(d.datdba) AS owner
				FROM pg_roles r JOIN pg_database d ON d.datname = r.rolname WHERE r.rolname = ${foreign}
			`;
			expect(kept).toEqual({ login: true, open: true, owner: foreign });
			expect(await connectAs(foreign, foreignPassword, foreign)).toBe(foreign);

			let unmarked = newRole();
			await sql.unsafe(`CREATE ROLE "${unmarked}" NOLOGIN`);
			await expect(server.provision(unmarked, newStorePassword())).rejects.toThrow(
				"wasn't made by Chopin",
			);
		});

		test("hands out no login while a database its administrator can't close lets machines connect", async () => {
			let suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
			let administrator = `store_admin_${suffix}`;
			let control = `store_control_${suffix}`;
			let unrelated = `unrelated_database_${suffix}`;
			let administratorPassword = newStorePassword();
			await sql.unsafe(
				`CREATE ROLE "${administrator}" LOGIN CREATEROLE CREATEDB PASSWORD '${administratorPassword}'`,
			);
			await sql.unsafe(`CREATE DATABASE "${control}" OWNER "${administrator}"`);
			await sql.unsafe(`CREATE DATABASE "${unrelated}"`);
			// It may connect to every database, as a managed service's administrator does, but owns only
			// its own, and every database but the unrelated one is closed to PUBLIC.
			let open = await sql<{ name: string }[]>`
				SELECT datname AS name FROM pg_database
				WHERE datallowconn AND datname NOT IN ${sql([control, unrelated])}
			`;
			for (let { name } of open) {
				await sql.unsafe(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
				await sql.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${administrator}"`);
			}
			await sql.unsafe(`GRANT CONNECT ON DATABASE "${unrelated}" TO "${administrator}"`);
			let url = new URL(database!);
			url.username = administrator;
			url.password = "";
			url.pathname = `/${control}`;
			let limited = new PostgresMachineStoreServer({
				url: url.href,
				password: administratorPassword,
			});
			let role = newRole();
			let password = newStorePassword();
			let storage = new MemoryStorage();
			await storage.migrate();
			let stores = new MachineStores({
				storage,
				server: limited,
				key: new Uint8Array(32).fill(5),
				clock: () => new Date(),
			});
			let userId = await owner(storage);
			let id = crypto.randomUUID();
			await storage.machines.create(machine(userId, { id }));
			let paired = (await storage.machines.get(id))!;
			let machineRole = machineStoreName(id);
			roles.push(machineRole);
			try {
				let refusal = await limited.provision(role, password).then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(refusal).toBeInstanceOf(MachineStoreRefusal);
				expect((refusal as Error).message).toContain(unrelated);
				expect(await refusedCode(connectAs(role, password, unrelated))).not.toBe("connected");
				expect(await refusedCode(connectAs(role, password, role))).not.toBe("connected");
				await expect(stores.login(paired)).rejects.toThrow(unrelated);
				expect((await stores.statuses([id])).get(id)).toEqual({
					state: "failed",
					reason: expect.stringContaining(unrelated),
				});
				// Once its owner closes it, the same administrator hands the login out.
				await sql.unsafe(`REVOKE CONNECT ON DATABASE "${unrelated}" FROM PUBLIC`);
				let login = await stores.login(paired);
				expect(await connectAs(machineRole, login.password, machineRole)).toBe(machineRole);
				expect(await refusedCode(connectAs(machineRole, login.password, unrelated))).toBe(
					"42501",
				);
				expect((await stores.statuses([id])).get(id)).toEqual({ state: "ready" });
			} finally {
				await limited.close();
				for (let name of [role, machineRole]) {
					await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
					await sql.unsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
				}
				for (let name of [control, unrelated]) {
					await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
				}
				for (let { name } of open) {
					await sql.unsafe(`REVOKE CONNECT ON DATABASE "${name}" FROM "${administrator}"`).catch(
						() => {},
					);
				}
				await sql.unsafe(`DROP ROLE IF EXISTS "${administrator}"`).catch(() => {});
			}
		});

		test("leaves alone the databases a service keeps open to every role, once its operator names them", async () => {
			let suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
			let administrator = `store_admin_${suffix}`;
			let control = `store_control_${suffix}`;
			let provider = `provider_${suffix}`;
			let health = `provider_health_${suffix}`;
			let maintenance = `provider_maintenance_${suffix}`;
			let administratorPassword = newStorePassword();
			await sql.unsafe(
				`CREATE ROLE "${administrator}" LOGIN CREATEROLE CREATEDB PASSWORD '${administratorPassword}'`,
			);
			await sql.unsafe(`CREATE ROLE "${provider}" NOLOGIN`);
			await sql.unsafe(`CREATE DATABASE "${control}" OWNER "${administrator}"`);
			// The service's own databases, which every role may connect to and its operator can't close.
			await sql.unsafe(`CREATE DATABASE "${health}" OWNER "${provider}"`);
			await sql.unsafe(`CREATE DATABASE "${maintenance}" OWNER "${provider}"`);
			let open = await sql<{ name: string }[]>`
				SELECT datname AS name FROM pg_database
				WHERE datallowconn AND datname NOT IN ${sql([control, health, maintenance])}
			`;
			for (let { name } of open) {
				await sql.unsafe(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
				await sql.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${administrator}"`);
			}
			let url = new URL(database!);
			url.username = administrator;
			url.password = "";
			url.pathname = `/${control}`;
			let limited = (openDatabases?: string[]) =>
				new PostgresMachineStoreServer({
					url: url.href,
					password: administratorPassword,
					...(openDatabases ? { openDatabases } : {}),
				});
			let unnamed = limited();
			let named = limited([health, maintenance]);
			let role = newRole();
			let other = newRole();
			let password = newStorePassword();
			let otherPassword = newStorePassword();
			try {
				let refusal = await unnamed.provision(role, password).catch((error: Error) => error);
				expect(refusal).toBeInstanceOf(MachineStoreRefusal);
				expect((refusal as Error).message).toContain(`${health} and ${maintenance}`);
				expect((refusal as Error).message).toContain("MACHINE_STORE_OPEN_DATABASES");
				expect(await refusedCode(connectAs(role, password, role))).not.toBe("connected");

				await named.provision(role, password);
				await named.provision(other, otherPassword);
				expect(await connectAs(role, password, role)).toBe(role);
				for (let name of [health, maintenance]) {
					expect(await connectAs(role, password, name)).toBe(role);
				}
				for (let name of ["postgres", "template1", control, other]) {
					expect(await refusedCode(connectAs(role, password, name))).toBe("42501");
				}
				let inside = asRole(role, password);
				try {
					let [trigrams] = await inside<{ schema: string }[]>`
						SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
						WHERE e.extname = 'pg_trgm'
					`;
					expect(trigrams).toEqual({ schema: "extensions" });
				} finally {
					await inside.close();
				}

				let mistaken = limited([health, other]);
				try {
					await expect(mistaken.provision(newRole(), newStorePassword())).rejects.toThrow(
						`MACHINE_STORE_OPEN_DATABASES names ${other}`,
					);
				} finally {
					await mistaken.close();
				}
			} finally {
				await unnamed.close();
				await named.close();
				for (let name of [role, other]) {
					await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
					await sql.unsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
				}
				for (let name of [control, health, maintenance]) {
					await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
				}
				for (let { name } of open) {
					await sql.unsafe(`REVOKE CONNECT ON DATABASE "${name}" FROM "${administrator}"`).catch(
						() => {},
					);
				}
				for (let name of [administrator, provider]) {
					await sql.unsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
				}
			}
		});

		test("turns off a login it made even after someone widened it", async () => {
			let role = newRole();
			let password = newStorePassword();
			await server.provision(role, password);
			await sql.unsafe(`ALTER ROLE "${role}" CREATEDB`);
			await expect(server.setPassword(role, newStorePassword())).rejects.toThrow(
				"can create databases",
			);
			await server.disable(role);
			expect(await refusedCode(connectAs(role, password, role))).not.toBe("connected");
		});

		test("stops new connections once turned off, and drops the database and role", async () => {
			let role = newRole();
			let password = newStorePassword();
			await server.provision(role, password);
			let open = asRole(role, password);
			await open`SELECT 1`;
			await server.disable(role);
			expect(await refusedCode(connectAs(role, password, role))).toBe("28000");
			expect(await server.accepts(role, password)).toBe(false);
			expect(await refusedCode(open`SELECT 1`)).not.toBe("connected");
			await open.close().catch(() => {});
			await server.drop(role);
			let left = await sql`
				SELECT 1 FROM pg_roles WHERE rolname = ${role}
				UNION ALL SELECT 1 FROM pg_database WHERE datname = ${role}
			`;
			expect(left.length).toBe(0);
		});

		test("sends PostgreSQL only a verifier, never the password", async () => {
			let proxy = await recordingProxy(database!);
			let recorded = new PostgresMachineStoreServer(administrator(proxy.url));
			try {
				let role = newRole();
				let password = newStorePassword();
				await recorded.provision(role, password);
				let next = newStorePassword();
				await recorded.setPassword(role, next);
				expect(await recorded.accepts(role, next)).toBe(true);
				let sent = proxy.sent();
				expect(sent).toContain("SCRAM-SHA-256$4096:");
				expect(sent).not.toContain(password);
				expect(sent).not.toContain(next);
				let [stored] = await sql<{ verifier: string }[]>`
					SELECT rolpassword AS verifier FROM pg_authid WHERE rolname = ${role}
				`;
				expect(stored!.verifier).toStartWith("SCRAM-SHA-256$4096:");
			} finally {
				await recorded.close();
				await proxy.close();
			}
		});

		test("hands each paired machine, whatever its id, one login a revocation turns off", async () => {
			let storage = new MemoryStorage();
			await storage.migrate();
			let stores = new MachineStores({
				storage,
				server,
				key: new Uint8Array(32).fill(3),
				clock: () => new Date(),
			});
			let lease = await testLease(storage);
			let machines = new Machines(storage, () => new Date(), {
				origin: "https://chopin.example",
				clientId: "client",
				lease: () => lease,
				revoked: id => stores.disable(id),
			});
			let userId = await owner(storage);
			let pair = async (id: string) => {
				await storage.machines.create(machine(userId, { id }));
				roles.push(machineStoreName(id));
				return (await storage.machines.get(id))!;
			};
			let laptop = await pair(crypto.randomUUID());
			let odd = await pair(`odd "machine"; DROP ROLE postgres; -- ${crypto.randomUUID()}`);
			let first = await stores.login(laptop);
			expect(await stores.login(laptop)).toEqual(first);
			let role = new URL(first.url).username;
			expect(await connectAs(role, first.password, role)).toBe(role);
			let theirs = await stores.login(odd);
			let theirRole = new URL(theirs.url).username;
			expect(theirRole).toMatch(/^m_x[0-9a-f]{48}$/);
			expect(await connectAs(theirRole, theirs.password, theirRole)).toBe(theirRole);
			expect(await refusedCode(connectAs(theirRole, theirs.password, role))).toBe("42501");
			await stores.rotate(laptop);
			let rotated = await stores.login(laptop);
			expect(await refusedCode(connectAs(role, first.password, role))).toBe("28P01");
			expect(await connectAs(role, rotated.password, role)).toBe(role);
			expect(await machines.revoke(laptop.id, userId)).toBe(true);
			expect(await refusedCode(connectAs(role, rotated.password, role))).not.toBe("connected");
			expect(await connectAs(theirRole, theirs.password, theirRole)).toBe(theirRole);
		});

		test("says plainly when it can't reach the server, without its password", async () => {
			let unreachable = new PostgresMachineStoreServer({
				url: "postgresql://admin@127.0.0.1:9/postgres?sslmode=disable",
				password: "administrator-secret",
			});
			try {
				let error = await unreachable.provision(newRole(), "machine-secret-password").then(
					() => undefined,
					(error: Error) => error,
				);
				expect(error).toBeInstanceOf(MachineStoreRefusal);
				expect(error?.message).toContain("couldn't reach the database server at 127.0.0.1:9");
				expect(error?.message).not.toContain("secret");
			} finally {
				await unreachable.close();
			}
		});
	});
}
