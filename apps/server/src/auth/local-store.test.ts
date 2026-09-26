import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { credentialName, LocalCredentials } from "./local-store";

import type { LocalCredential, NativeSecrets } from "./local-store";

let directories: string[] = [];
afterEach(async () => {
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	directories = [];
});

async function fixture(secrets: NativeSecrets, timeout = 20) {
	let root = await mkdtemp(join(tmpdir(), "chopin-credentials-test-"));
	directories.push(root);
	let store = new LocalCredentials(join(root, "config"), secrets, timeout);
	let record: LocalCredential = {
		v: 1,
		installation: "isolated",
		origin: "http://localhost:8790",
		clientId: "client",
		accountId: "U_one",
		login: "one",
		bindingId: crypto.randomUUID(),
		bindingSecretHash: "abcdef",
		accessToken: "ghu_local_secret",
		accessExpiresAt: Date.now() + 30_000,
		refreshToken: "ghr_local_secret",
		refreshExpiresAt: Date.now() + 60_000,
		backend: "keychain",
		generation: 1,
	};
	return { root, store, record };
}

function fake() {
	let values = new Map<string, string>();
	let secrets: NativeSecrets = {
		get: async ({ name }) => values.get(name) ?? null,
		set: async ({ name, value }) => {
			values.set(name, value);
		},
		delete: async ({ name }) => values.delete(name),
	};
	return { values, secrets };
}

describe("local credential persistence", () => {
	it("saves to the native-store boundary without a plaintext copy and scopes the binding", async () => {
		let { values, secrets } = fake();
		let { store, record, root } = await fixture(secrets);
		expect(await store.saveSecure(record)).toBe(true);
		expect(values.has(credentialName(record))).toBe(true);
		expect(await readdir(root)).toEqual([]);
		expect(await store.read(record)).toMatchObject({
			accountId: record.accountId,
			backend: "keychain",
		});
		for (let field of ["installation", "origin", "clientId", "bindingId"] as const) {
			expect(await store.read({ ...record, [field]: `${record[field]}-other` })).toBeUndefined();
		}
		await store.delete(record);
		expect(values.size).toBe(0);
	});

	it("requires explicit plaintext save when the vault is missing, locked or fails", async () => {
		for (let reason of ["missing", "locked", "failed"]) {
			let secrets: NativeSecrets = {
				get: async () => {
					throw new Error(reason);
				},
				set: async () => {
					throw new Error(reason);
				},
				delete: async () => false,
			};
			let { root, store, record } = await fixture(secrets);
			expect(await store.saveSecure(record)).toBe(false);
			expect(await readdir(root)).toEqual([]);
			await store.save({ ...record, backend: "plaintext" });
			let path = store.path(record);
			expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ backend: "plaintext" });
			expect(await store.read(record)).toMatchObject({ backend: "plaintext" });
			await store.delete(record);
			expect(await readdir(join(root, "config"))).toEqual([]);
		}
	});

	it("creates missing parent directories privately for the plaintext fallback", async () => {
		let { secrets } = fake();
		let root = await mkdtemp(join(tmpdir(), "chopin-credentials-test-"));
		directories.push(root);
		let nested = join(root, "missing", "nested", "chopin");
		let store = new LocalCredentials(nested, secrets, 20);
		let record: LocalCredential = {
			v: 1,
			installation: "isolated",
			origin: "http://localhost:8790",
			clientId: "client",
			accountId: "U_one",
			login: "one",
			bindingId: crypto.randomUUID(),
			bindingSecretHash: "abcdef",
			accessToken: "ghu_local_secret",
			accessExpiresAt: Date.now() + 30_000,
			refreshToken: "ghr_local_secret",
			refreshExpiresAt: Date.now() + 60_000,
			backend: "plaintext",
			generation: 1,
		};
		await store.save(record);
		for (let segment of [join(root, "missing"), join(root, "missing", "nested"), nested]) {
			expect((await stat(segment)).mode & 0o777).toBe(0o700);
		}
		let path = store.path(record);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect(await store.read(record)).toMatchObject({ backend: "plaintext" });
		await store.delete(record);
		expect(await readdir(nested)).toEqual([]);
	});

	it("bounds a delayed store, then removes a late write instead of reviving it", async () => {
		let release = Promise.withResolvers<void>();
		let { values, secrets } = fake();
		secrets.set = async ({ name, value }) => {
			await release.promise;
			values.set(name, value);
		};
		let { store, record, root } = await fixture(secrets, 10);
		expect(await store.saveSecure(record)).toBe(false);
		expect(await readdir(root)).toEqual([]);
		await store.delete(record);
		release.resolve();
		await Bun.sleep(20);
		expect(values.size).toBe(0);
	});

	it("removes a timed-out refresh write that completes after logout", async () => {
		let release = Promise.withResolvers<void>();
		let { values, secrets } = fake();
		secrets.set = async ({ name, value }) => {
			await release.promise;
			values.set(name, value);
		};
		let { store, record } = await fixture(secrets, 10);
		await expect(store.save(record)).rejects.toThrow("system vault unavailable");
		await store.delete(record);
		release.resolve();
		await Bun.sleep(20);
		expect(values.size).toBe(0);
	});

	it("rejects a path inside the checkout and atomically saves an outside file", async () => {
		let { secrets } = fake();
		expect(() => new LocalCredentials(join(process.cwd(), "credentials"), secrets))
			.toThrow("outside the repository");
		let { store, record } = await fixture(secrets);
		let invalid = { ...record, backend: "plaintext" as const };
		let path = store.path(record);
		await store.save(invalid);
		expect(await readFile(path, "utf8")).toContain("ghu_local_secret");
	});

	if (process.env.TEST_NATIVE_SECRETS) {
		it("round-trips through the real OS credential store (opt-in native check)", async () => {
			let root = await mkdtemp(join(tmpdir(), "chopin-credentials-native-"));
			directories.push(root);
			let store = new LocalCredentials(join(root, "config"));
			let record: LocalCredential = {
				v: 1,
				installation: "native-check",
				origin: "http://localhost:8790",
				clientId: "client",
				accountId: "U_native",
				login: "native",
				bindingId: crypto.randomUUID(),
				bindingSecretHash: "abcdef",
				accessToken: "ghu_native_dummy",
				accessExpiresAt: Date.now() + 30_000,
				refreshToken: "ghr_native_dummy",
				refreshExpiresAt: Date.now() + 60_000,
				backend: "keychain",
				generation: 1,
			};
			let name = credentialName(record);
			expect(await store.saveSecure(record)).toBe(true);
			console.info(`native secret check: key ${name}, length ${JSON.stringify(record).length}`);
			expect(await readdir(root)).toEqual([]);
			expect(await store.read(record)).toMatchObject({
				accountId: record.accountId,
				backend: "keychain",
			});
			await store.delete(record);
			expect(await Bun.secrets.get({ service: "chopin-local-auth", name })).toBeNull();
		});
	}
});
