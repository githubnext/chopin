/**
 * Which client is each document's remote Planner.
 *
 * Attaching makes the client's account the document's Planner owner through
 * the same generation-guarded storage claim a browser owner takes elsewhere.
 * The owner is the account's live browser login, because Chopin's repository
 * tools act with that login's GitHub App token, never with the link's bearer.
 * A dropped or detached link keeps its ownership for a grace period, so the
 * same account can reattach without losing it; then the ownership is cleared.
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
	sessions: Pick<Sessions, "forUser" | "use">;
	clock: () => Date;
};

export type AttachRequest = {
	channelId: string;
	repository: { id: string; owner: string; name: string };
	user: { id: string; login: string };
};

export type AttachRefusal = {
	ok: false;
	code: "planner-attached" | "sign-in-required" | "repository-forbidden";
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

	/** Stops every grace timer. Ownership stays in storage, which startup clears. */
	close(): void {
		for (let hold of this.#holds.values()) clearTimeout(hold.timer);
		this.#holds.clear();
	}

	async #attach(request: AttachRequest, link: PlannerLink): Promise<AttachGrant | AttachRefusal> {
		let { channelId, user } = request;
		let held = this.#holds.get(channelId);
		if (held && (held.link || held.userId !== user.id)) return attachedRefusal(held);
		let login = await this.#eligibleLogin(request);
		if ("ok" in login) return login;
		let now = this.#auth.clock();
		if (held) {
			let stored = await this.#auth.storage.channels.readAgent(channelId, now);
			if (
				stored?.agent?.ownerSessionId === held.ownerSessionId
				&& stored.agent.generation === held.generation
			) return this.#bind(held, link);
			this.#drop(held);
		}
		let claimed = await this.#claim(channelId, login.session.id, now);
		if (!claimed) throw new Error("The document's Planner owner changed while attaching.");
		let hold: Hold = {
			channelId,
			userId: user.id,
			login: user.login,
			ownerSessionId: login.session.id,
			generation: claimed.generation,
		};
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
		});
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
