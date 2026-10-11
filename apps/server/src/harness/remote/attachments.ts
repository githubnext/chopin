/**
 * Which client is each document's remote Planner.
 *
 * Attaching makes the client's account the document's Planner owner through
 * the same generation-guarded storage claim a browser owner takes elsewhere.
 * The owner is the account's live browser login, because Chopin's repository
 * tools act with that login's GitHub App token, never with the link's bearer.
 * A dropped or detached link keeps its ownership for a grace period, so the
 * same account can reattach without losing it; then the ownership is cleared.
 * Ending that login, resetting the document's Planner, or any other release of
 * the stored ownership closes the link and frees the document at once.
 */

import { GitHubError } from "../../github/client";
import { attachLink } from "./registry";

import type { Admission } from "../../auth/admission";
import type { AuthConfig } from "../../auth/config";
import type { AuthenticatedSession, Sessions } from "../../auth/session";
import type { GitHub } from "../../github/client";
import type { StorageAdapter } from "../../storage/port";
import type { PlannerLink } from "./link";

export type AttachmentAuth = {
	config: Pick<AuthConfig, "origin">;
	storage: Pick<StorageAdapter, "channels">;
	github: Pick<GitHub, "repositoryAccess">;
	admission: Pick<Admission, "allowed">;
	sessions: Pick<Sessions, "forUser" | "resolve" | "use">;
	clock: () => Date;
};

export type AttachRequest = {
	channelId: string;
	repository: { id: string; owner: string; name: string };
	user: { id: string; login: string };
};

export type AttachRefusal = {
	ok: false;
	code: "planner-attached" | "sign-in-required" | "repository-forbidden" | "access-revoked";
	message: string;
};

export type AttachGrant = { ok: true; detach: () => void };

type Hold = {
	channelId: string;
	userId: string;
	login: string;
	ownerSessionId: string;
	generation: number;
	link?: PlannerLink;
	forget?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	releaseAt?: Date;
};

type PendingAttach = {
	login: string;
	held?: Hold;
	sessionIds: Set<string>;
	invalidated?: AttachRefusal;
};

/** What `@chopin` and `invoke_planner` say when no Planner is attached to the document. */
export function notAttachedMessage(url: string, repository: string): string {
	return `No Planner is attached to this document. To attach one, connect a Planner client to `
		+ `${url} over the Planner link from a session in a checkout of ${repository}; `
		+ `that session becomes this document's Planner.`;
}

export function forbiddenMessage(repository: string): string {
	return `Attaching as this document's Planner needs push or administration access to ${repository}.`;
}

export class PlannerAttachments {
	#auth: AttachmentAuth;
	#graceMs: number;
	#holds = new Map<string, Hold>();
	#pending = new Map<string, PendingAttach>();
	#queues = new Map<string, Promise<void>>();

	constructor(auth: AttachmentAuth, graceMs: number) {
		this.#auth = auth;
		this.#graceMs = graceMs;
	}

	/** Whether a client is attached to the document now, not merely holding it through a grace period. */
	attached(channelId: string): boolean {
		return this.#holds.get(channelId)?.link !== undefined;
	}

	/** The GitHub login holding the document's Planner, attached or within its grace period. */
	holder(channelId: string): string | undefined {
		return this.#holds.get(channelId)?.login;
	}

	/** Makes `link` the document's Planner and its account the owner, or says why not. */
	attach(request: AttachRequest, link: PlannerLink): Promise<AttachGrant | AttachRefusal> {
		return this.#serialized(request.channelId, () => this.#attach(request, link));
	}

	/** The browser login ended: every document it owns through an attachment is released. */
	async sessionRevoked(sessionId: string): Promise<void> {
		let origin = this.#auth.config.origin;
		for (let pending of this.#pending.values()) {
			if (!pending.sessionIds.has(sessionId)) continue;
			pending.invalidated ??= pending.held?.ownerSessionId === sessionId
				? signInEndedRefusal(origin, pending.login)
				: signInRefusal(origin, pending.login);
		}
		let held = [...this.#holds.values()].filter(hold => hold.ownerSessionId === sessionId);
		for (let hold of held) this.#invalidate(hold, signInEndedRefusal(origin, hold.login));
		await Promise.all(held.map(hold => this.#release(hold)));
	}

	/** A repository writer reset the document's Planner, which already cleared its stored owner. */
	ownerReset(channelId: string): void {
		let pending = this.#pending.get(channelId);
		if (pending) pending.invalidated ??= resetRefusal(pending.login);
		let hold = this.#holds.get(channelId);
		if (hold) this.#invalidate(hold, resetRefusal(hold.login));
	}

	/**
	 * Whether `link` still holds the document: its login is still live and the
	 * stored owner is still its attachment's login and generation.
	 * Otherwise the link closes and the document is free to attach.
	 */
	async verify(channelId: string, link: PlannerLink): Promise<boolean> {
		let hold = this.#holds.get(channelId);
		if (hold?.link !== link) return false;
		let stored = await this.#auth.storage.channels.readAgent(channelId, this.#auth.clock());
		let live = await this.#auth.sessions.resolve(hold.ownerSessionId);
		if (this.#holds.get(channelId) !== hold || hold.link !== link) return false;
		if (!live) {
			this.#invalidate(hold, signInEndedRefusal(this.#auth.config.origin, hold.login));
			await this.#release(hold);
			return false;
		}
		if (
			stored?.agent?.ownerSessionId === hold.ownerSessionId
			&& stored.agent.generation === hold.generation
		) return true;
		this.#invalidate(hold, {
			ok: false,
			code: "access-revoked",
			message: `This document's Planner ownership was released, so ${hold.login} is no longer `
				+ `attached. Attach again to resume.`,
		});
		return false;
	}

	/** Stops every grace timer. Ownership stays in storage, which startup clears. */
	close(): void {
		for (let hold of this.#holds.values()) clearTimeout(hold.timer);
		this.#holds.clear();
	}

	async #attach(request: AttachRequest, link: PlannerLink): Promise<AttachGrant | AttachRefusal> {
		let { channelId, user } = request;
		let held = this.#holds.get(channelId);
		if (held && (held.link || held.userId !== user.id)) return attachedRefusal(held);
		let pending: PendingAttach = {
			login: user.login,
			held,
			sessionIds: new Set(held ? [held.ownerSessionId] : []),
		};
		this.#pending.set(channelId, pending);
		try {
			return await this.#attachPending(request, link, pending);
		} finally {
			if (this.#pending.get(channelId) === pending) this.#pending.delete(channelId);
		}
	}

	/**
	 * Takes or keeps the document for `request` while `pending` collects every
	 * reset or ended login that lands during its awaits, so a hold binds only
	 * if nothing released its ownership in the meantime.
	 */
	async #attachPending(
		request: AttachRequest,
		link: PlannerLink,
		pending: PendingAttach,
	): Promise<AttachGrant | AttachRefusal> {
		let { channelId, user } = request;
		let login = await this.#eligibleLogin(request);
		if ("ok" in login) return login;
		pending.sessionIds.add(login.session.id);
		if (pending.invalidated) return pending.invalidated;
		let now = this.#auth.clock();
		let held = pending.held;
		if (held && this.#holds.get(channelId) === held) {
			let stored = await this.#auth.storage.channels.readAgent(channelId, now);
			let live = await this.#auth.sessions.resolve(held.ownerSessionId);
			if (pending.invalidated) return pending.invalidated;
			if (
				live && this.#holds.get(channelId) === held
				&& stored?.agent?.ownerSessionId === held.ownerSessionId
				&& stored.agent.generation === held.generation
			) return this.#bind(held, link);
			this.#drop(held);
			if (!live) await this.#release(held);
		}
		if (pending.invalidated) return pending.invalidated;
		let claimed = await this.#claim(channelId, login.session.id, now);
		if (!claimed) throw new Error("The document's Planner owner changed while attaching.");
		let hold: Hold = {
			channelId,
			userId: user.id,
			login: user.login,
			ownerSessionId: login.session.id,
			generation: claimed.generation,
		};
		let live = await this.#auth.sessions.resolve(hold.ownerSessionId);
		let refusal = pending.invalidated
			?? (live ? undefined : signInRefusal(this.#auth.config.origin, user.login));
		if (refusal) {
			await this.#release(hold);
			return refusal;
		}
		this.#holds.set(channelId, hold);
		return this.#bind(hold, link);
	}

	async #eligibleLogin(request: AttachRequest): Promise<AuthenticatedSession | AttachRefusal> {
		let { repository, user } = request;
		let fullName = `${repository.owner}/${repository.name}`;
		let login = await this.#auth.sessions.forUser(user.id);
		if (!login) return signInRefusal(this.#auth.config.origin, user.login);
		let checked;
		try {
			checked = await this.#auth.sessions.use(
				login,
				token => this.#auth.github.repositoryAccess(token, repository.owner, repository.name),
			);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 401) {
				return signInRefusal(this.#auth.config.origin, user.login);
			}
			throw error;
		}
		let access = checked.value;
		if (
			!access || access.id !== repository.id
			|| (!access.permissions.push && !access.permissions.admin)
			|| !await this.#auth.admission.allowed(checked.authenticated.access.token, user.id)
		) return { ok: false, code: "repository-forbidden", message: forbiddenMessage(fullName) };
		return checked.authenticated;
	}

	/**
	 * Claims the document for `sessionId`. Under the remote Planner only an
	 * attachment takes ownership, so an owner no attachment holds is stale and
	 * is cleared, guarded by its generation, before claiming again.
	 */
	async #claim(channelId: string, sessionId: string, now: Date) {
		let channels = this.#auth.storage.channels;
		let state = await channels.claimAgentOwner(channelId, sessionId, now);
		if (state.ownerSessionId === sessionId) return state;
		if (state.ownerSessionId) {
			await channels.clearAgentOwner(channelId, state.ownerSessionId, state.generation, now);
		}
		state = await channels.claimAgentOwner(channelId, sessionId, now);
		return state.ownerSessionId === sessionId ? state : undefined;
	}

	#bind(hold: Hold, link: PlannerLink): AttachGrant {
		clearTimeout(hold.timer);
		hold.timer = undefined;
		hold.releaseAt = undefined;
		hold.link = link;
		hold.forget = attachLink(hold.channelId, link);
		return { ok: true, detach: () => this.#detached(hold, link) };
	}

	#detached(hold: Hold, link: PlannerLink): void {
		if (hold.link !== link) return;
		hold.link = undefined;
		hold.forget?.();
		hold.forget = undefined;
		if (this.#holds.get(hold.channelId) !== hold) return;
		hold.releaseAt = new Date(this.#auth.clock().getTime() + this.#graceMs);
		hold.timer = setTimeout(() => void this.#expire(hold), this.#graceMs);
		hold.timer.unref?.();
	}

	#expire(hold: Hold): Promise<void> {
		return this.#serialized(hold.channelId, async () => {
			if (this.#holds.get(hold.channelId) !== hold || hold.link) return;
			this.#drop(hold);
			await this.#release(hold);
		});
	}

	/** Forgets the hold before its link closes, so closing starts no grace period. */
	#invalidate(hold: Hold, refusal: AttachRefusal): void {
		if (this.#holds.get(hold.channelId) !== hold) return;
		this.#drop(hold);
		hold.link?.revoke(refusal.code, refusal.message);
	}

	async #release(hold: Hold): Promise<void> {
		try {
			await this.#auth.storage.channels.clearAgentOwner(
				hold.channelId,
				hold.ownerSessionId,
				hold.generation,
				this.#auth.clock(),
			);
		} catch (error) {
			console.error("[planner-link] releasing the Planner owner failed:", error);
		}
	}

	#drop(hold: Hold): void {
		clearTimeout(hold.timer);
		hold.timer = undefined;
		if (this.#holds.get(hold.channelId) === hold) this.#holds.delete(hold.channelId);
	}

	#serialized<T>(channelId: string, action: () => Promise<T>): Promise<T> {
		let previous = this.#queues.get(channelId) ?? Promise.resolve();
		let next = previous.then(action);
		let settled = next.then(() => {}, () => {});
		this.#queues.set(channelId, settled);
		void settled.then(() => {
			if (this.#queues.get(channelId) === settled) this.#queues.delete(channelId);
		});
		return next;
	}
}

function resetRefusal(login: string): AttachRefusal {
	return {
		ok: false,
		code: "access-revoked",
		message: `A repository writer reset this document's Planner, so ${login} is no longer `
			+ `attached. Attach again to resume.`,
	};
}

function attachedRefusal(hold: Hold): AttachRefusal {
	let message = hold.link || !hold.releaseAt
		? `${hold.login} is attached as this document's Planner. A document has one Planner at a time.`
		: `${hold.login} detached from this document's Planner and holds it until `
			+ `${hold.releaseAt.toISOString()} unless they reattach. A document has one Planner at a time.`;
	return { ok: false, code: "planner-attached", message };
}

function signInRefusal(origin: string, login: string): AttachRefusal {
	return {
		ok: false,
		code: "sign-in-required",
		message: `Sign in to Chopin at ${origin} in a browser as ${login}, then attach again. `
			+ `The Planner's repository tools act with that sign-in.`,
	};
}

function signInEndedRefusal(origin: string, login: string): AttachRefusal {
	return {
		ok: false,
		code: "sign-in-required",
		message: `The Chopin browser sign-in that made ${login} this document's Planner ended, so the `
			+ `Planner was released. Sign in to Chopin at ${origin} in a browser as ${login}, then `
			+ `attach again.`,
	};
}
