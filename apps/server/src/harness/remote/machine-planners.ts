/**
 * Planner credentials for paired machines.
 *
 * A paired machine asks for a short-lived credential naming one document, and
 * hands it to a Planner backend command, which attaches over `/planner-link`
 * with it instead of a GitHub bearer. The machine's owner then holds the
 * document's Planner through a delegated login whose GitHub token is the
 * machine's own, so no browser sign-in is needed and signing out of one does
 * not release it. Revoking the machine, or GitHub refusing its authorization,
 * ends that login, which closes its links at once.
 */

import { createHash, randomBytes } from "node:crypto";

import { MachineError } from "../../auth/machines";
import { GitHubTokenError } from "../../github/client";
import { locateDocument } from "../../mcp/hosted";

import type { HostedAuth } from "../../auth/routes";
import type { StoredMachine } from "../../storage/model";

/** How long a Planner credential can open a link; an open link no longer depends on it. */
export const PLANNER_CREDENTIAL_MS = 15 * 60_000;
const PREFIX = "chopin_p_";
const TOKEN = /^chopin_p_[A-Za-z0-9_-]{43}$/;

export type MachinePlannerAuth =
	& Pick<HostedAuth, "config" | "machines" | "sessions" | "storage" | "github">
	& { clock?: () => Date };

type Issued = { machineId: string; channelId: string; expiresAt: number };

/** What a redeemed credential lets a link do: be `machine`'s Planner for one document. */
export type MachineGrant = { machine: StoredMachine; channelId: string };

function digest(token: string): string {
	return createHash("sha256").update(token).digest("base64url");
}

export class MachinePlanners {
	#auth: MachinePlannerAuth;
	#issued = new Map<string, Issued>();
	#logins = new Map<string, Promise<string>>();

	constructor(auth: MachinePlannerAuth) {
		this.#auth = auth;
		auth.machines.onEnded(machineId => void this.#ended(machineId));
	}

	#now(): number {
		return (this.#auth.clock ?? (() => new Date()))().getTime();
	}

	/** A credential for `machine` to attach as `channelId`'s Planner; only its hash is kept. */
	issue(machine: StoredMachine, channelId: string): { token: string; expiresAt: number } {
		let now = this.#now();
		for (let [key, issued] of this.#issued) {
			if (issued.expiresAt <= now) this.#issued.delete(key);
		}
		let token = PREFIX + randomBytes(32).toString("base64url");
		let expiresAt = now + PLANNER_CREDENTIAL_MS;
		this.#issued.set(digest(token), { machineId: machine.id, channelId, expiresAt });
		return { token, expiresAt };
	}

	/** Whether a bearer is shaped as a Planner credential rather than a GitHub token. */
	static claims(token: string): boolean {
		return token.startsWith(PREFIX);
	}

	/** The live machine and document an unexpired credential names; throws `MachineError`. */
	async redeem(token: string): Promise<MachineGrant | undefined> {
		let issued = TOKEN.test(token) ? this.#issued.get(digest(token)) : undefined;
		if (!issued || issued.expiresAt <= this.#now()) return undefined;
		let machine = await this.current({ id: issued.machineId } as StoredMachine);
		return { machine, channelId: issued.channelId };
	}

	/**
	 * The machine as stored now, once it is still paired and authorized and its owner still passes
	 * admission with the machine's own token; otherwise throws `MachineError`.
	 */
	async current(machine: StoredMachine): Promise<StoredMachine> {
		let stored = await this.#auth.machines.current(machine.id);
		await this.#auth.machines.access(stored);
		return stored;
	}

	/** The document a locator names, read with the machine's own GitHub token. */
	locate(machine: StoredMachine, document: string) {
		return this.#auth.machines.use(machine, async token => {
			let user = await this.#auth.storage.users.get(machine.userId);
			return locateDocument(this.#auth, {
				oauthToken: token,
				user: { id: machine.userId, login: user?.login ?? machine.userId, avatarUrl: "" },
			}, document);
		});
	}

	/**
	 * The login `machine`'s Planner owns documents through, or undefined when machines hold no
	 * GitHub credentials of their own (AUTH_MODE=local) and must borrow a browser sign-in.
	 */
	async login(machine: StoredMachine): Promise<string | undefined> {
		if (!this.#auth.machines.durable) return undefined;
		let existing = this.#logins.get(machine.id);
		if (existing) {
			let id = await existing.catch(() => undefined);
			if (id && this.#auth.sessions.isLive(id)) return id;
			if (this.#logins.get(machine.id) === existing) this.#logins.delete(machine.id);
		}
		let created = this.#auth.sessions.delegate(machine.userId, async rejected => {
			try {
				return await this.#auth.machines.access(
					await this.#auth.machines.current(machine.id),
					rejected,
				);
			} catch (error) {
				if (error instanceof MachineError) throw new GitHubTokenError(error.code, 401, true);
				throw error;
			}
		});
		this.#logins.set(machine.id, created);
		void created.catch(() => {
			if (this.#logins.get(machine.id) === created) this.#logins.delete(machine.id);
		});
		return created;
	}

	/** A revoked or unauthorized machine's credentials and login end now. */
	async #ended(machineId: string): Promise<void> {
		for (let [key, issued] of this.#issued) {
			if (issued.machineId === machineId) this.#issued.delete(key);
		}
		let login = this.#logins.get(machineId);
		this.#logins.delete(machineId);
		let id = await login?.catch(() => undefined);
		if (!id) return;
		try {
			await this.#auth.sessions.end(id);
		} catch (error) {
			console.error("[planner-link] ending a machine's Planner login failed:", error);
		}
	}
}
