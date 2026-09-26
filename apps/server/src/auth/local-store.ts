import { GitHubError } from "../github/client";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { GitHubTokenGrant } from "../github/client";

export type Backend = "keychain" | "plaintext";
export type LocalCredential = {
	v: 1;
	installation: string;
	origin: string;
	clientId: string;
	accountId: string;
	login: string;
	bindingId: string;
	bindingSecretHash: string;
	accessToken: string;
	accessExpiresAt: number;
	refreshToken: string;
	refreshExpiresAt: number;
	backend: Backend;
	generation: number;
};

export type NativeSecrets = Pick<typeof Bun.secrets, "get" | "set" | "delete">;
const SERVICE = "chopin-local-auth";
const LIMIT_MS = 5_000;

export function credentialName(
	input: Pick<LocalCredential, "installation" | "origin" | "clientId" | "bindingId">,
): string {
	return `v1:${
		createHash("sha256").update(JSON.stringify([
			input.installation,
			input.origin,
			input.clientId,
			input.bindingId,
		])).digest("hex")
	}`;
}

export function credentialGrant(record: LocalCredential, now: number): GitHubTokenGrant {
	return {
		accessToken: record.accessToken,
		accessExpiresIn: Math.max(1, Math.floor((record.accessExpiresAt - now) / 1_000)),
		refreshToken: record.refreshToken,
		refreshExpiresIn: Math.max(1, Math.floor((record.refreshExpiresAt - now) / 1_000)),
	};
}

export class LocalCredentials {
	readonly #directory: string;
	readonly #secrets: NativeSecrets;
	readonly #timeout: number;
	readonly #pending = new Map<string, Set<Promise<unknown>>>();

	constructor(directory: string, secrets: NativeSecrets = Bun.secrets, timeout = LIMIT_MS) {
		this.#directory = resolve(directory.replace(/^~(?=\/|$)/, homedir()));
		this.#secrets = secrets;
		this.#timeout = timeout;
		let cwd = resolve(process.cwd());
		let relation = relative(cwd, this.#directory);
		if (!relation || (!relation.startsWith("..") && !isAbsolute(relation))) {
			throw new Error("CHOPIN_LOCAL_CREDENTIALS_DIR must be outside the repository");
		}
	}

	path(input: Pick<LocalCredential, "installation" | "origin" | "clientId" | "bindingId">) {
		return resolve(this.#directory, `${credentialName(input)}.json`);
	}

	async #bounded<T>(task: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				task,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("system vault unavailable")), this.#timeout);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	async saveSecure(record: LocalCredential): Promise<boolean> {
		let name = credentialName(record);
		let task = Promise.resolve().then(() =>
			this.#secrets.set({
				service: SERVICE,
				name,
				value: JSON.stringify({ ...record, backend: "keychain" }),
			})
		);
		let pending = this.#pending.get(name) ?? new Set();
		pending.add(task);
		this.#pending.set(name, pending);
		try {
			await this.#bounded(task);
			await rm(this.path(record), { force: true });
			console.info(`chopin: local credential key ${name}`);
			return true;
		} catch {
			void task.then(() =>
				this.#bounded(
					Promise.resolve().then(() => this.#secrets.delete({ service: SERVICE, name })),
				).catch(() => {})
			).catch(() => {});
			return false;
		} finally {
			void task.finally(() => {
				pending.delete(task);
				if (!pending.size) this.#pending.delete(name);
			}).catch(() => {});
		}
	}

	async save(record: LocalCredential): Promise<void> {
		if (record.backend === "keychain") {
			let name = credentialName(record);
			let task = Promise.resolve().then(() =>
				this.#secrets.set({
					service: SERVICE,
					name,
					value: JSON.stringify(record),
				})
			);
			let pending = this.#pending.get(name) ?? new Set();
			pending.add(task);
			this.#pending.set(name, pending);
			try {
				await this.#bounded(task);
			} catch (err) {
				void task.then(() =>
					this.#bounded(
						Promise.resolve().then(() => this.#secrets.delete({ service: SERVICE, name })),
					).catch(() => {})
				).catch(() => {});
				throw err;
			} finally {
				void task.finally(() => {
					pending.delete(task);
					if (!pending.size) this.#pending.delete(name);
				}).catch(() => {});
			}
			return;
		}
		let parent = dirname(this.path(record));
		let created = false;
		try {
			await mkdir(parent, { mode: 0o700 });
			created = true;
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
		}
		if (created && process.platform !== "win32") await chmod(parent, 0o700);
		let info = await lstat(parent);
		if (
			!info.isDirectory() || info.isSymbolicLink()
			|| (process.platform !== "win32" && (info.mode & 0o077) !== 0)
		) {
			throw new Error("credential directory is not private");
		}
		let canonical = await realpath(parent);
		let cwd = await realpath(process.cwd());
		let relation = relative(cwd, canonical);
		if (!relation || (!relation.startsWith("..") && !isAbsolute(relation))) {
			throw new Error("credential directory must be outside the repository");
		}
		let target = this.path(record);
		let temporary = `${target}.${crypto.randomUUID()}.tmp`;
		let file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(record));
			await file.sync();
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, target);
			let dir = await open(parent, "r");
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		} catch (err) {
			await rm(temporary, { force: true });
			throw err;
		}
	}

	async read(
		input: Pick<LocalCredential, "installation" | "origin" | "clientId" | "bindingId">,
	): Promise<LocalCredential | undefined> {
		let name = credentialName(input);
		let values: Array<{ value: string; backend: Backend }> = [];
		let vaultFailed = false;
		try {
			let value = await this.#bounded(
				Promise.resolve().then(() => this.#secrets.get({ service: SERVICE, name })),
			);
			if (value) values.push({ value, backend: "keychain" });
		} catch {
			vaultFailed = true;
		}
		try {
			let file = this.path(input);
			let info = await lstat(file);
			if (
				!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32"
					&& (info.mode & 0o077) !== 0)
			) throw new Error("credential file is not private");
			values.push({ value: await readFile(file, "utf8"), backend: "plaintext" });
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
		}
		for (let candidate of values) {
			let record: Partial<LocalCredential>;
			try {
				record = JSON.parse(candidate.value);
			} catch {
				continue;
			}
			if (
				record.v !== 1 || record.backend !== candidate.backend
				|| record.installation !== input.installation || record.origin !== input.origin
				|| record.clientId !== input.clientId || record.bindingId !== input.bindingId
				|| typeof record.accountId !== "string" || typeof record.login !== "string"
				|| typeof record.bindingSecretHash !== "string"
				|| typeof record.accessToken !== "string" || typeof record.refreshToken !== "string"
				|| !Number.isSafeInteger(record.accessExpiresAt)
				|| !Number.isSafeInteger(record.refreshExpiresAt)
				|| !Number.isSafeInteger(record.generation)
			) continue;
			return record as LocalCredential;
		}
		if (vaultFailed && !values.length) throw new GitHubError("System vault is unavailable", 503);
		return undefined;
	}

	async delete(
		input: Pick<LocalCredential, "installation" | "origin" | "clientId" | "bindingId">,
	): Promise<void> {
		let name = credentialName(input);
		await rm(this.path(input), { force: true });
		try {
			await this.#bounded(
				Promise.resolve().then(() => this.#secrets.delete({ service: SERVICE, name })),
			);
		} catch {
			// The binding is already invalidated even when the vault cannot be reached.
		}
		let pending = this.#pending.get(name);
		if (pending) {
			for (let task of pending) {
				void task.then(() =>
					this.#bounded(
						Promise.resolve().then(() => this.#secrets.delete({ service: SERVICE, name })),
					).catch(() => {})
				).catch(() => {});
			}
		}
	}
}
