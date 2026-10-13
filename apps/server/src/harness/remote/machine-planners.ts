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
	/** The login each machine's links attach through now, while it is created or once it is. */
	#logins = new Map<string, Promise<string>>();
	/** Every login created for each machine that may still be live, all ended with the machine. */
	#delegated = new Map<string, Set<string>>();

	constructor(auth: MachinePlannerAuth) {
		this.#auth = auth;
		auth.machines.onEnded(machineId => void this.#ended(machineId));
	}

	#now(): number {
		return (this.#auth.clock ?? (() => new Date()))().getTime();
	}

	/** Forgets every credential that can no longer open a link. */
	#prune(now: number): void {
		for (let [key, issued] of this.#issued) {
			if (issued.expiresAt <= now) this.#issued.delete(key);
		}
	}

	/** A credential for `machine` to attach as `channelId`'s Planner; only its hash is kept. */
	issue(machine: StoredMachine, channelId: string): { token: string; expiresAt: number } {
		let now = this.#now();
		this.#prune(now);
		let token = PREFIX + randomBytes(32).toString("base64url");
		let expiresAt = now + PLANNER_CREDENTIAL_MS;
		this.#issued.set(digest(token), { machineId: machine.id, channelId, expiresAt });
		return { token, expiresAt };
	}

	/** Whether a bearer is shaped as a Planner credential rather than a GitHub token. */
	static claims(token: string): boolean {
		return token.startsWith(PREFIX);
	}

	/**
	 * The live machine and document an unexpired credential names; throws `MachineError`. Until it
	 * expires a credential may open links again, so a backend can reattach after a dropped socket.
	 */
	async redeem(token: string): Promise<MachineGrant | undefined> {
		this.#prune(this.#now());
		let issued = TOKEN.test(token) ? this.#issued.get(digest(token)) : undefined;
		if (!issued) return undefined;
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
		for (let existing; (existing = this.#logins.get(machine.id));) {
			let id = await existing.catch(() => undefined);
			// Another call replaced it while this one waited: share that one, never create a second.
			if (this.#logins.get(machine.id) !== existing) continue;
			if (id && this.#auth.sessions.isLive(id)) return id;
			this.#logins.delete(machine.id);
			if (id) void this.#end(machine.id, id);
			break;
		}
		let created = this.#delegate(machine);
		this.#logins.set(machine.id, created);
		void created.catch(() => {
			if (this.#logins.get(machine.id) === created) this.#logins.delete(machine.id);
		});
		return created;
	}

	async #delegate(machine: StoredMachine): Promise<string> {
		let id = await this.#auth.sessions.delegate(machine.userId, async rejected => {
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
		let delegated = this.#delegated.get(machine.id) ?? new Set();
		this.#delegated.set(machine.id, delegated.add(id));
		return id;
	}

	/** A revoked or unauthorized machine's credentials and every login it holds end now. */
	async #ended(machineId: string): Promise<void> {
		for (let [key, issued] of this.#issued) {
			if (issued.machineId === machineId) this.#issued.delete(key);
		}
		let current = this.#logins.get(machineId);
		this.#logins.delete(machineId);
		await current?.catch(() => undefined);
		let delegated = this.#delegated.get(machineId) ?? new Set<string>();
		this.#delegated.delete(machineId);
		await Promise.all([...delegated].map(id => this.#end(machineId, id)));
	}

	async #end(machineId: string, id: string): Promise<void> {
		this.#delegated.get(machineId)?.delete(id);
		try {
			await this.#auth.sessions.end(id);
		} catch (error) {
			console.error("[planner-link] ending a machine's Planner login failed:", error);
		}
	}
}
