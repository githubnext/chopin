/**
 * Which client is each document's remote Planner.
 *
 * Attaching makes the client's account the document's Planner owner through
 * the same generation-guarded storage claim a browser owner takes elsewhere.
 * The owner is the account's live browser login, because Chopin's repository
 * tools act with that login's GitHub App token, never with the link's bearer.
 * A detached link, or one that dropped with nothing to keep, keeps its ownership
 * for a grace period, so the same account can reattach without losing it; then
 * the ownership is cleared. A link that dropped unexpectedly while its client had
 * workflow runs or open questions to resume keeps its ownership with no deadline:
 * the work waits for the client, however long that takes, and only something
 * explicit ends it. Ending that login, resetting the document's Planner, choosing
 * another machine for it, archiving or deleting the document, or any other
 * release of the stored ownership closes the link and frees the document at once.
 *
 * A paired machine's Planner owns through the machine's delegated login
 * instead, whose GitHub token is the machine's own; it ends when the machine
 * is revoked or must be authorized again, never with a browser sign-out.
 */

import { LINK_CLOSE } from "@chopin/agent-link";

import { GitHubError } from "../../github/client";
import { AgentLink, type RejoinHost } from "./link";
import { attachLink } from "./registry";

import type { Session } from "@chopin/protocol";
import type { Admission } from "../../auth/admission";
import type { AuthConfig } from "../../auth/config";
import type { AuthenticatedSession, Sessions } from "../../auth/session";
import type { GitHub } from "../../github/client";
import type { PlannerLinkHold, StoredPlannerLinkHold } from "../../storage/model";
import type { StorageAdapter } from "../../storage/port";

export type AttachmentAuth = {
	config: Pick<AuthConfig, "origin">;
	storage: Pick<StorageAdapter, "channels"> & Partial<Pick<StorageAdapter, "machines">>;
	github: Pick<GitHub, "repositoryAccess">;
	admission: Pick<Admission, "allowed">;
	sessions: Pick<Sessions, "forUser" | "resolve" | "use">;
	clock: () => Date;
};

export type AttachRequest = {
	channelId: string;
	repository: { id: string; owner: string; name: string };
	user: { id: string; login: string };
	/**
	 * The login to own the document through instead of the account's browser sign-in: a paired
	 * machine's delegated login, with the machine's label for what its links are told.
	 */
	login?: string;
	machine?: string;
	/** That machine's id, so choosing another machine for the document can stop its Planner. */
	machineId?: string;
};

export type AttachRefusal = {
	ok: false;
	code:
		| "planner-attached"
		| "sign-in-required"
		| "repository-forbidden"
		| "access-revoked"
		| "document-archived"
		| "unavailable";
	message: string;
};

export type AttachGrant = {
	ok: true;
	/** Lets go of the attachment; `suspended` keeps the link's sessions for the next link to resume. */
	detach: (suspended?: boolean) => void;
	/** Takes the sessions the account's earlier link kept while it was disconnected, if any. */
	claim: () => AgentLink | undefined;
	/** The link that dropped with work kept has none left, so its hold runs a grace period. */
	lapse: () => void;
	/**
	 * Present when the account's earlier link still counted as attached: the grant stands for
	 * nothing until the client's first message, a resume naming a session that earlier link
	 * holds, shows its connection is gone. Then the earlier link is closed as the unexpected
	 * drop it is, its work parked, and `takeover` gives the grant that takes it. It is present
	 * too for a hold a restart rebuilt whose owner's browser has not come back yet: `names` is
	 * undefined when the client's first message is not a resume.
	 */
	takeover?: (
		names: Array<{ session: string; requests: string[] }> | undefined,
	) => Promise<AttachGrant | AttachRefusal>;
};

/**
 * Where a hold is kept so the process that takes over can rebuild it. Absent under
 * `AUTH_MODE=local`, which is never handed over: its holds stay in memory.
 */
export type HoldStore = {
	put(hold: PlannerLinkHold): Promise<void>;
	delete(channelId: string): Promise<void>;
};

/**
 * What became of the workflow runs a rebuilt hold keeps, for the cards Chat stored: their client
 * did not come back in time (`down`), came back and took them (`up`), or they ended with the hold.
 */
export type RestoredRuns = "down" | "up" | "ended";

export type PlannerAttachmentOptions = {
	store?: HoldStore;
	/** Heard when a rebuilt hold's runs change as `RestoredRuns` says. */
	restoredRuns?: (channelId: string, outcome: RestoredRuns) => void;
	/** Heard when a hand-over window ends without the client back, with what was missing. */
	missed?: (channelId: string, cause: "login" | "client") => void;
};

/** What a document's members are told about its Planner: only the holder's login and state. */
export type PlannerAttachment = Session.PlannerAttachment;

type AttachmentListener = (channelId: string, planner: PlannerAttachment) => void;

type Hold = {
	channelId: string;
	userId: string;
	login: string;
	ownerSessionId: string;
	generation: number;
	/** The paired machine whose delegated login owns the document, by label and id. */
	machine?: string;
	machineId?: string;
	link?: AgentLink;
	/** A dropped link that kept its sessions, for the account's next link to resume or something explicit to end. */
	parked?: AgentLink;
	forget?: () => void;
	timer?: ReturnType<typeof setTimeout>;
	releaseAt?: Date;
	/** Rebuilt after a restart and not yet taken back by a link. */
	restored?: boolean;
	/** Until then a hold whose link a cut closed is shown as attached, as it is when it returns. */
	handoverUntil?: Date;
	handoverTimer?: ReturnType<typeof setTimeout>;
	/** Whether storage holds a row for it that something must remove. */
	persisted?: boolean;
};

type PendingAttach = {
	login: string;
	machine?: string;
	held?: Hold;
	sessionIds: Set<string>;
	invalidated?: AttachRefusal;
};

/**
 * What `@chopin` and `invoke_planner` say when no Planner is attached to the document, in plain
 * words that name none of Chopin's own terms: a machine is needed. With `machines`, when Chopin
 * runs Planners on people's machines, how to get one there; otherwise how to connect a client.
 */
export function notAttachedMessage(url: string, repository: string, machines = false): string {
	if (machines) {
		return "Connect a machine to get a reply. Choose one with the machine button, "
			+ "or run `chopin connect` on a machine that can reply.";
	}
	return `Connect a machine to get a reply. Connect an agent client to ${url} over the agent `
		+ `connection from a session in a checkout of ${repository}.`;
}

/**
 * What `@chopin` and `invoke_planner` say while the document's Planner is disconnected: it has
 * not stopped, the work is kept, and it carries on when the machine is back. It names only its
 * owner's login, never the machine.
 */
export function disconnectedMessage(login: string | undefined): string {
	return `${login ? `@${login}'s machine` : "The machine"} is offline, so it can't reply now. `
		+ "Your work is kept and picks up when it's back.";
}

/**
 * What `@chopin` and `invoke_planner` say when the Planner a machine is starting is not ready:
 * still connecting to it, wait a moment, or, once its backend has failed to start more than once,
 * that it can't connect and why, as the machine reported it. It speaks of the machine, as the
 * document's machine button does, and names only its owner's login, never the machine.
 */
export function startingMessage(login: string, failure?: Session.PlannerStartFailure): string {
	if (failure) {
		return `Can't connect to @${login}'s machine: ${failure.reason} `
			+ `(${failure.attempts} attempts in a row). It keeps trying; try again once that is fixed.`;
	}
	return `Still connecting to @${login}'s machine. Try again in a moment.`;
}

export function forbiddenMessage(repository: string): string {
	return `Connecting to this document needs push or administration access to ${repository}.`;
}

/** How often a resume that waits for the owner's browser sign-in looks for it. */
const LOGIN_POLL_MS = 50;

/**
 * How long after the cut wrote a hold a process may still rebuild it with a window. A hand-over,
 * from the write to the next process taking the lease, takes seconds and minutes at the very
 * worst, and a process never rebuilds a hold for longer than a window; a row older than this was
 * left by a cut that no process was started to follow, and its window is long past.
 */
const HOLD_STALE_MS = 60 * 60_000;

export class PlannerAttachments {
	#auth: AttachmentAuth;
	#graceMs: number;
	#holds = new Map<string, Hold>();
	#pending = new Map<string, PendingAttach>();
	/** How many times each document ended its Planner, so a link that waited through one is refused. */
	#endings = new Map<string, number>();
	#queues = new Map<string, Promise<void>>();
	#listeners = new Set<AttachmentListener>();
	#options: PlannerAttachmentOptions;
	/** Each document's pending row writes, in order, so a removal never overtakes a save. */
	#rows = new Map<string, Promise<void>>();
	/** The cut has taken the holds' state: nothing more is written, and nothing is announced. */
	#frozen = false;

	constructor(auth: AttachmentAuth, graceMs: number, options: PlannerAttachmentOptions = {}) {
		this.#auth = auth;
		this.#graceMs = graceMs;
		this.#options = options;
	}

	/** Whether a hold's link was closed by a cut and its window has not run out. */
	#inWindow(hold: Hold): boolean {
		return hold.link === undefined && hold.handoverUntil !== undefined
			&& hold.handoverUntil > this.#auth.clock();
	}

	/** Whether a client is attached to the document now, not merely holding it through a grace period. */
	attached(channelId: string): boolean {
		return this.#holds.get(channelId)?.link !== undefined;
	}

	/**
	 * Whether the client attached to the document waits on its members: an open question or run.
	 * So does one that disconnected, whose work is kept for it.
	 */
	waiting(channelId: string): boolean {
		let hold = this.#holds.get(channelId);
		return hold?.link ? hold.link.waiting : hold?.parked !== undefined;
	}

	/**
	 * Whether the client attached to the document is mid-work: replying, asking, or running. A
	 * disconnected client's kept work is mid-work, as nothing says it ended.
	 */
	busy(channelId: string): boolean {
		let hold = this.#holds.get(channelId);
		return hold?.link ? hold.link.busy : hold?.parked !== undefined;
	}

	/**
	 * Whether the document's Planner holds work that only an explicit end may take away: its link
	 * waits on its members, or dropped and left its work kept.
	 */
	keeping(channelId: string): boolean {
		return this.waiting(channelId);
	}

	/** Waits at most `ms` for a client to attach to the document; whether one is attached then. */
	attachedWithin(channelId: string, ms: number): Promise<boolean> {
		if (this.attached(channelId)) return Promise.resolve(true);
		return new Promise(resolve => {
			let finish = () => {
				clearTimeout(timer);
				unsubscribe();
				resolve(this.attached(channelId));
			};
			let unsubscribe = this.onChange(id => {
				if (id === channelId && this.attached(channelId)) finish();
			});
			let timer = setTimeout(finish, ms);
		});
	}

	/**
	 * Whether a client is attached and its ownership still stands, checked as
	 * the link's periodic recheck does. A stale attachment is closed and
	 * released here, so a Planner request never proceeds on it.
	 */
	async confirmed(channelId: string): Promise<boolean> {
		let link = this.#holds.get(channelId)?.link;
		return link !== undefined && await this.verify(channelId, link);
	}

	/** The GitHub login holding the document's Planner, attached or within its grace period. */
	holder(channelId: string): string | undefined {
		return this.#holds.get(channelId)?.login;
	}

	/**
	 * Who holds the document's Planner, attached or within its grace period: the account, and the
	 * paired machine whose Planner backend holds it, if one does. Only for its owner's own views.
	 */
	holding(
		channelId: string,
	):
		| {
			userId: string;
			login: string;
			machineId?: string;
			attached: boolean;
			/** The link dropped and its work is kept for it: a hold nothing but something explicit ends. */
			disconnected: boolean;
		}
		| undefined
	{
		let hold = this.#holds.get(channelId);
		if (!hold) return undefined;
		return {
			userId: hold.userId,
			login: hold.login,
			...(hold.machineId !== undefined ? { machineId: hold.machineId } : {}),
			attached: hold.link !== undefined || this.#inWindow(hold),
			disconnected: hold.link === undefined && !this.#inWindow(hold) && hold.parked !== undefined,
		};
	}

	/**
	 * Whether a Planner backend of paired machine `machineId` is attached now, or was a moment ago,
	 * when a deploy cut its link and it is expected back within its window: the machine is running
	 * even if its connector has yet to speak to this process.
	 */
	machineBacked(machineId: string): boolean {
		for (let hold of this.#holds.values()) {
			if (hold.machineId === machineId && (hold.link || this.#inWindow(hold))) return true;
		}
		return false;
	}

	/**
	 * The Planner backend of paired machine `machineId` stops being the document's Planner, as its
	 * owner chose another machine or it disconnected: an attached link is refused with `message`
	 * and closed, and the ownership released without a grace period, ending what a disconnected
	 * link kept as well, since a person chose that. A hold through any other login, or one
	 * already in its grace period, is left as it is.
	 */
	stopMachine(channelId: string, machineId: string, message: string): Promise<void> {
		return this.#serialized(channelId, async () => {
			let hold = this.#holds.get(channelId);
			if (!hold || hold.machineId !== machineId) return;
			if (!(hold.link || hold.parked || hold.restored)) return;
			this.#invalidate(hold, { ok: false, code: "access-revoked", message });
			await this.#release(hold);
		});
	}

	/**
	 * Whether the document's Planner is attached, disconnected with its work kept, held through a
	 * grace period, or free, and by whom.
	 */
	status(channelId: string): PlannerAttachment {
		let hold = this.#holds.get(channelId);
		if (!hold) return { state: "none" };
		if (hold.link || this.#inWindow(hold)) return { state: "attached", login: hold.login };
		if (!hold.releaseAt) {
			return hold.parked
				? { state: "disconnected", login: hold.login }
				: { state: "attached", login: hold.login };
		}
		return { state: "held", login: hold.login, until: hold.releaseAt.toISOString() };
	}

	/**
	 * Calls `listener` with the new status whenever a document's changes: an attach,
	 * a detach into the grace period, and every release. Returns the unsubscribe.
	 */
	onChange(listener: AttachmentListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Makes `link` the document's Planner and its account the owner, or says why not. */
	attach(request: AttachRequest, link: AgentLink): Promise<AttachGrant | AttachRefusal> {
		return this.#serialized(request.channelId, () => this.#attach(request, link));
	}

	/**
	 * A hold a restart rebuilt for a browser sign-in is taken back only once that sign-in is back,
	 * which its browser's cookie restores. The returning client's first message, its `resume`, waits
	 * for it through the hold's window: nothing is refused, the link stays as it is, the document
	 * shows the machine attached, and the sessions are handed back the moment the sign-in is. A
	 * resume still without it when the window is over, or after it, is refused with `unavailable`,
	 * which the client retries, and the hold stays as it is.
	 */
	#awaitingLogin(request: AttachRequest, link: AgentLink, held: Hold): AttachGrant {
		let unavailable = {
			ok: false,
			code: "unavailable",
			message: "Chopin has not restored the sign-in this connection runs under yet.",
		} as const;
		return {
			ok: true,
			detach: () => {},
			claim: () => undefined,
			lapse: () => {},
			// Waiting outside the document's queue, which the window's own end needs.
			takeover: async names => {
				if (names !== undefined) await this.#awaitLogin(held, link);
				return this.#serialized(request.channelId, async () => {
					if (!link.attached) return unavailable;
					if (this.#holds.get(request.channelId) !== held || held.link) {
						return this.#attach(request, link, true);
					}
					if (names === undefined) return this.#attach(request, link, true);
					if (!await this.#auth.sessions.resolve(held.ownerSessionId)) return unavailable;
					return this.#attach(request, link, true);
				});
			},
		};
	}

	/** Until the owner's sign-in is back, the hold's window is over, or the link is gone. */
	async #awaitLogin(hold: Hold, link: AgentLink): Promise<void> {
		while (
			link.attached && this.#holds.get(hold.channelId) === hold && !hold.link
			&& this.#inWindow(hold) && !await this.#auth.sessions.resolve(hold.ownerSessionId)
		) await new Promise(resolve => setTimeout(resolve, LOGIN_POLL_MS));
	}

	/** The browser login ended: every document it owns through an attachment is released. */
	async sessionRevoked(sessionId: string): Promise<void> {
		let origin = this.#auth.config.origin;
		for (let pending of this.#pending.values()) {
			if (!pending.sessionIds.has(sessionId)) continue;
			pending.invalidated ??= pending.machine !== undefined
				? machineEndedRefusal(pending.machine, pending.login)
				: pending.held?.ownerSessionId === sessionId
				? signInEndedRefusal(origin, pending.login)
				: signInRefusal(origin, pending.login);
		}
		let held = [...this.#holds.values()].filter(hold => hold.ownerSessionId === sessionId);
		for (let hold of held) this.#invalidate(hold, endedRefusal(origin, hold));
		await Promise.all(held.map(hold => this.#release(hold)));
	}

	/**
	 * The document was archived or is being deleted: the Planner it held ends with it, whether
	 * attached or disconnected with work kept, and nothing may attach to it.
	 */
	documentEnded(channelId: string): Promise<void> {
		this.#endings.set(channelId, (this.#endings.get(channelId) ?? 0) + 1);
		return this.#serialized(channelId, async () => {
			let pending = this.#pending.get(channelId);
			let hold = this.#holds.get(channelId);
			if (pending) pending.invalidated ??= documentEndedRefusal();
			if (!hold) return;
			this.#invalidate(hold, documentEndedRefusal());
			await this.#release(hold);
		});
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
	async verify(channelId: string, link: AgentLink): Promise<boolean> {
		let hold = this.#holds.get(channelId);
		if (hold?.link !== link) return false;
		let stored = await this.#auth.storage.channels.readAgent(channelId, this.#auth.clock());
		let live = await this.#auth.sessions.resolve(hold.ownerSessionId);
		if (this.#holds.get(channelId) !== hold || hold.link !== link) return false;
		if (!live) {
			this.#invalidate(hold, endedRefusal(this.#auth.config.origin, hold));
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
			message: `This document's connection was released, so ${hold.login} is no longer `
				+ `connected. Connect again to resume.`,
		});
		return false;
	}

	/** A machine was revoked or must be authorized again: the hold a restart rebuilt for it ends. */
	async machineEnded(machineId: string): Promise<void> {
		let ended = [...this.#holds.values()].filter(hold =>
			hold.machineId === machineId && hold.link === undefined
		);
		for (let hold of ended) {
			this.#invalidate(hold, machineEndedRefusal(hold.machine ?? "", hold.login));
		}
		await Promise.all(ended.map(hold => this.#release(hold)));
	}

	/**
	 * Rebuilds the holds a process that has since restarted wrote at its cut: each as a suspended
	 * hold whose client's `resume` takes it back. One whose document or paired machine is gone, or
	 * whose stored owner is no longer the login it named, ends and its row with it. Until its
	 * window runs out a hold a cut closed is shown as attached. Only this process is given that
	 * window: its row is rewritten without it, so a process that starts after this one crashed
	 * finds the hold of a link that had already dropped, disconnected.
	 */
	async restore(rows: StoredPlannerLinkHold[]): Promise<void> {
		let now = this.#auth.clock();
		for (let row of rows) {
			let channel = await this.#auth.storage.channels.get(row.channelId);
			let machines = this.#auth.storage.machines;
			let machine = row.machineId !== undefined && machines
				? await machines.get(row.machineId)
				: undefined;
			let agent = row.ownerSessionId !== undefined
				? (await this.#auth.storage.channels.readAgent(row.channelId, now))?.agent
				: undefined;
			let stale = !channel || channel.archivedAt
				|| (row.machineId !== undefined && machines && (!machine || machine.revokedAt))
				|| (row.ownerSessionId !== undefined
					&& (agent?.ownerSessionId !== row.ownerSessionId || agent.generation !== row.generation));
			let hold: Hold = {
				channelId: row.channelId,
				userId: row.userId,
				login: row.login,
				ownerSessionId: row.ownerSessionId ?? "",
				generation: row.generation,
				...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
				...(row.machine !== undefined ? { machine: row.machine } : {}),
				restored: true,
				persisted: true,
			};
			if (stale) {
				this.#forgetRow(hold);
				continue;
			}
			if (row.sessions.length > 0) {
				hold.parked = AgentLink.rebuilt(row.channelId, row.sessions, {
					lapse: () => this.#lapsed(hold, hold.parked!),
					ended: () => this.#runs(hold, "ended"),
					resumed: () => this.#runs(hold, "up"),
				});
			}
			let length = row.handoverUntil
					&& this.#auth.clock().getTime() - row.suspendedAt.getTime() <= HOLD_STALE_MS
				? row.handoverUntil.getTime() - row.suspendedAt.getTime()
				: undefined;
			// Before the hold is shown, so a crash from here on leaves a row with no window. A write
			// that fails leaves the row as it was, and the window the client was told is still given.
			if (length !== undefined && this.#options.store) {
				try {
					await this.#options.store.put({ ...row, handoverUntil: undefined });
				} catch (error) {
					console.error("[agent] keeping a remote Planner's link state failed:", error);
				}
			}
			this.#holds.set(row.channelId, hold);
			// The window is the length the cut gave, counted from here: the cut could not know when
			// its lease would be released, and this is after it was, however long the steps between
			// its write and its release took and however late this process took the lease. Only a
			// row older than `HOLD_STALE_MS` is no window's: no process was started to take it back.
			let taken = this.#auth.clock();
			if (length !== undefined) {
				hold.handoverUntil = new Date(taken.getTime() + length);
				hold.handoverTimer = setTimeout(() => void this.#windowEnded(hold), length);
				hold.handoverTimer.unref?.();
			} else if (!hold.parked) {
				// A window that ran out while no process was there, for a client with nothing to resume.
				this.#startGrace(hold);
			}
		}
	}

	/**
	 * The room of `channelId` is open: the questions a rebuilt hold's client left open are waited
	 * on again, for it, through `host`.
	 */
	rejoinInputs(channelId: string, host: RejoinHost): void {
		let hold = this.#holds.get(channelId);
		hold?.parked?.rejoinInputs(host);
		hold?.link?.rejoinInputs(host);
	}

	/**
	 * Whether a hold a restart rebuilt still keeps sessions its client has not taken back, so the
	 * workflow runs Chat stored for the document are live and not stopped when its Chat opens:
	 * `live` through the hold's window, `down` once its client is known to be away.
	 */
	restoredWork(channelId: string): "live" | "down" | undefined {
		let hold = this.#holds.get(channelId);
		if (!hold?.restored || !hold.parked || hold.parked.snapshot().length === 0) return undefined;
		return this.#inWindow(hold) ? "live" : "down";
	}

	/**
	 * The cut: takes each hold's state for the next process, in the order a window needs, and stops
	 * everything this one does with holds. A hold whose link is live gets a hand-over window, whose
	 * length the next process counts from the moment it rebuilds the hold, which is after the
	 * release; one that was already disconnected keeps its state, because the deploy did not cause
	 * it, and one in its grace period keeps nothing.
	 */
	freeze(windowMs: number): PlannerLinkHold[] {
		this.#frozen = true;
		let now = this.#auth.clock();
		let rows: PlannerLinkHold[] = [];
		for (let hold of this.#holds.values()) {
			let source = hold.link ?? hold.parked;
			if (!source && !hold.restored) continue;
			let sessions = source?.snapshot() ?? [];
			let { ownerSessionId, machineId, machine } = hold;
			let handoverUntil = hold.link
				? new Date(now.getTime() + windowMs)
				: hold.handoverUntil && hold.handoverUntil > now
				? hold.handoverUntil
				: undefined;
			rows.push({
				channelId: hold.channelId,
				userId: hold.userId,
				login: hold.login,
				...(machineId === undefined ? { ownerSessionId } : { machineId, machine: machine! }),
				generation: hold.generation,
				sessions,
				suspendedAt: now,
				...(handoverUntil ? { handoverUntil } : {}),
			});
		}
		this.close();
		return rows;
	}

	/**
	 * Writes what `freeze` took; a hold that cannot be written is missing from the next process. The
	 * row says when it was written and how long the window is. The next process counts the window
	 * from its own rebuild of the hold, so no step between this write and the release, however
	 * slow, takes anything from it; the write time only tells a row from an old cut from this one.
	 */
	async persist(rows: PlannerLinkHold[]): Promise<void> {
		let store = this.#options.store;
		if (!store) return;
		await Promise.all(this.#rows.values());
		let written = this.#auth.clock();
		await Promise.all(rows.map(async row => {
			try {
				await store.put(
					row.handoverUntil
						? {
							...row,
							suspendedAt: written,
							handoverUntil: new Date(
								written.getTime() + row.handoverUntil.getTime() - row.suspendedAt.getTime(),
							),
						}
						: row,
				);
			} catch (error) {
				console.error("[agent] keeping a remote Planner's link state failed:", error);
			}
		}));
	}

	/** The server is going down: no link withdraws a question it asked on its way out. */
	shutdown(): void {
		for (let hold of this.#holds.values()) {
			hold.link?.shutdown();
			hold.parked?.shutdown();
		}
	}

	/** Stops every grace timer. Ownership stays in storage, which startup clears. */
	close(): void {
		this.#frozen = true;
		for (let hold of this.#holds.values()) {
			clearTimeout(hold.timer);
			clearTimeout(hold.handoverTimer);
			hold.parked?.terminate();
		}
		this.#holds.clear();
	}

	async #attach(
		request: AttachRequest,
		link: AgentLink,
		restoring = false,
	): Promise<AttachGrant | AttachRefusal> {
		let { channelId, user } = request;
		let held = this.#holds.get(channelId);
		if (
			!restoring && held?.restored && !held.link && held.userId === user.id
			&& request.login === undefined && held.machine === undefined
			&& !await this.#auth.sessions.resolve(held.ownerSessionId)
		) return this.#awaitingLogin(request, link, held);
		if (held && (held.link || held.userId !== user.id)) {
			// The same account's client may be returning to a link whose connection died unnoticed:
			// only its first message, a resume naming what that link holds, can say so.
			let earlier = held.link;
			if (
				earlier && held.userId === user.id && link.resumable && earlier.resumable
				&& (request.login ? held.ownerSessionId === request.login : held.machine === undefined)
			) {
				let ending = this.#endings.get(channelId) ?? 0;
				return {
					ok: true,
					detach: () => {},
					claim: () => undefined,
					lapse: () => {},
					takeover: names => this.#takeover(request, link, earlier, names, ending),
				};
			}
			return attachedRefusal(held);
		}
		let pending: PendingAttach = {
			login: user.login,
			...(request.machine !== undefined ? { machine: request.machine } : {}),
			held,
			sessionIds: new Set(held?.ownerSessionId ? [held.ownerSessionId] : []),
		};
		this.#pending.set(channelId, pending);
		try {
			return await this.#attachPending(request, link, pending);
		} finally {
			if (this.#pending.get(channelId) === pending) this.#pending.delete(channelId);
		}
	}

	/**
	 * A resume that names a session `earlier` holds shows its client left that link: it is closed
	 * as the unexpected drop it is, its work parked, and this link attaches and takes it. Any
	 * other first message, or another link already holding the document, is refused as before.
	 */
	#takeover(
		request: AttachRequest,
		link: AgentLink,
		earlier: AgentLink,
		names: Array<{ session: string; requests: string[] }> | undefined,
		ending: number,
	): Promise<AttachGrant | AttachRefusal> {
		return this.#serialized(request.channelId, async () => {
			// The document archived, or was deleted, while this link waited for its first message.
			if ((this.#endings.get(request.channelId) ?? 0) !== ending) return documentEndedRefusal();
			let current = this.#holds.get(request.channelId);
			if (current?.link) {
				if (current.link !== earlier || !earlier.holds(names ?? [])) {
					return attachedRefusal(current);
				}
				earlier.close(LINK_CLOSE.unresponsive, "superseded");
			}
			let attached = await this.#attach(request, link);
			if (attached.ok && attached.takeover) {
				return attachedRefusal(this.#holds.get(request.channelId)!);
			}
			return attached;
		});
	}

	/**
	 * Takes or keeps the document for `request` while `pending` collects every
	 * reset or ended login that lands during its awaits, so a hold binds only
	 * if nothing released its ownership in the meantime.
	 */
	async #attachPending(
		request: AttachRequest,
		link: AgentLink,
		pending: PendingAttach,
	): Promise<AttachGrant | AttachRefusal> {
		let { channelId, user } = request;
		let login = await this.#eligibleLogin(request, pending);
		if ("ok" in login) return login;
		if (pending.invalidated) return pending.invalidated;
		let now = this.#auth.clock();
		let held = pending.held;
		// A machine that comes back after a restart owns through a login its grant made again: that
		// login takes over the hold the old one named.
		let returning = held?.restored && request.login !== undefined
			&& held.machineId !== undefined && held.machineId === request.machineId;
		// A machine owns through its own login and a browser client through a sign-in; neither
		// keeps a hold that rests on the other's.
		if (
			held && !returning
			&& (request.login ? held.ownerSessionId !== request.login : held.machine !== undefined)
		) {
			if (this.#holds.get(channelId) === held) {
				this.#drop(held);
				await this.#release(held);
			}
			held = undefined;
		}
		if (held && returning && this.#holds.get(channelId) === held) {
			let claimed;
			try {
				claimed = await this.#claim(channelId, login.session.id, now);
			} catch (error) {
				if (pending.invalidated) return pending.invalidated;
				throw error;
			}
			if (pending.invalidated) return pending.invalidated;
			if (!claimed || this.#holds.get(channelId) !== held) {
				throw new Error("The document's agent owner changed while connecting.");
			}
			held.ownerSessionId = login.session.id;
			held.generation = claimed.generation;
			return this.#bind(held, link);
		}
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
		let claimed;
		try {
			claimed = await this.#claim(channelId, login.session.id, now);
		} catch (error) {
			// Storage refuses a claim for a sign-in that ended after its last check.
			if (pending.invalidated) return pending.invalidated;
			if (!await this.#auth.sessions.resolve(login.session.id)) {
				return request.machine !== undefined
					? machineEndedRefusal(request.machine, user.login)
					: signInRefusal(this.#auth.config.origin, user.login);
			}
			throw error;
		}
		if (!claimed) throw new Error("The document's agent owner changed while connecting.");
		let hold: Hold = {
			channelId,
			userId: user.id,
			login: user.login,
			ownerSessionId: login.session.id,
			generation: claimed.generation,
			...(request.machine !== undefined ? { machine: request.machine } : {}),
			...(request.machineId !== undefined ? { machineId: request.machineId } : {}),
		};
		let live = await this.#auth.sessions.resolve(hold.ownerSessionId);
		let refusal = pending.invalidated
			?? (live ? undefined : endedRefusal(this.#auth.config.origin, hold, false));
		if (refusal) {
			await this.#release(hold);
			return refusal;
		}
		this.#holds.set(channelId, hold);
		return this.#bind(hold, link);
	}

	/**
	 * The caller's browser login, registered with `pending` before its access
	 * checks so that its sign-out during them refuses the attach.
	 */
	async #eligibleLogin(
		request: AttachRequest,
		pending: PendingAttach,
	): Promise<AuthenticatedSession | AttachRefusal> {
		let { repository, user } = request;
		let fullName = `${repository.owner}/${repository.name}`;
		let login = request.login
			? await this.#auth.sessions.resolve(request.login)
			: await this.#auth.sessions.forUser(user.id);
		if (!login) {
			return request.machine !== undefined
				? machineEndedRefusal(request.machine, user.login)
				: signInRefusal(this.#auth.config.origin, user.login);
		}
		pending.sessionIds.add(login.session.id);
		let checked;
		try {
			checked = await this.#auth.sessions.use(
				login,
				token => this.#auth.github.repositoryAccess(token, repository.owner, repository.name),
			);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 401) {
				return request.machine !== undefined
					? machineEndedRefusal(request.machine, user.login)
					: signInRefusal(this.#auth.config.origin, user.login);
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

	#bind(hold: Hold, link: AgentLink): AttachGrant {
		clearTimeout(hold.timer);
		clearTimeout(hold.handoverTimer);
		hold.timer = undefined;
		hold.handoverTimer = undefined;
		hold.releaseAt = undefined;
		hold.handoverUntil = undefined;
		hold.restored = false;
		this.#forgetRow(hold);
		hold.link = link;
		hold.forget = attachLink(hold.channelId, link);
		this.#changed(hold.channelId);
		return {
			ok: true,
			detach: suspended => this.#detached(hold, link, suspended),
			claim: () => {
				if (hold.link !== link) return undefined;
				let parked = hold.parked;
				hold.parked = undefined;
				return parked;
			},
			lapse: () => this.#lapsed(hold, link),
		};
	}

	/** The disconnected link has nothing left to keep: its account holds the document as a detached one does. */
	#lapsed(hold: Hold, link: AgentLink): void {
		if (hold.parked !== link || this.#holds.get(hold.channelId) !== hold) return;
		hold.parked = undefined;
		if (hold.link) return;
		this.#startGrace(hold);
	}

	#startGrace(hold: Hold): void {
		hold.releaseAt = new Date(this.#auth.clock().getTime() + this.#graceMs);
		hold.timer = setTimeout(() => void this.#expire(hold), this.#graceMs);
		hold.timer.unref?.();
		this.#changed(hold.channelId);
	}

	#detached(hold: Hold, link: AgentLink, suspended = false): void {
		if (hold.link !== link) {
			if (suspended) link.terminate();
			return;
		}
		hold.link = undefined;
		hold.forget?.();
		hold.forget = undefined;
		if (this.#holds.get(hold.channelId) !== hold) {
			if (suspended) link.terminate();
			return;
		}
		if (suspended) {
			// Only one earlier link's sessions can wait; a link that dropped before resuming gives
			// way to the one that kept its own. What it kept has no deadline: the account holds the
			// document until its client returns or something explicit ends the hold.
			if (hold.parked && hold.parked !== link) hold.parked.terminate();
			hold.parked = link;
			this.#saveRow(hold, link);
		}
		// A link that came back and dropped again before resuming leaves the earlier one's work
		// waiting, still with no deadline.
		if (hold.parked) {
			this.#changed(hold.channelId);
			return;
		}
		this.#startGrace(hold);
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
		// A machine's rebuilt hold names no login, and the restart already cleared the owner it had.
		if (!hold.ownerSessionId) return;
		try {
			await this.#auth.storage.channels.clearAgentOwner(
				hold.channelId,
				hold.ownerSessionId,
				hold.generation,
				this.#auth.clock(),
			);
		} catch (error) {
			console.error("[agent] releasing the Planner owner failed:", error);
		}
	}

	#drop(hold: Hold): void {
		clearTimeout(hold.timer);
		clearTimeout(hold.handoverTimer);
		hold.timer = undefined;
		hold.handoverTimer = undefined;
		if (this.#holds.get(hold.channelId) !== hold) return;
		this.#forgetRow(hold);
		// Whatever a dropped link kept goes with the ownership it rested on.
		hold.parked?.terminate();
		hold.parked = undefined;
		this.#holds.delete(hold.channelId);
		this.#changed(hold.channelId);
	}

	/** The rebuilt hold's window ran out with its client not back: it is disconnected from now on. */
	#windowEnded(hold: Hold): Promise<void> {
		return this.#serialized(hold.channelId, async () => {
			if (this.#holds.get(hold.channelId) !== hold || hold.link || !hold.handoverUntil) return;
			hold.handoverUntil = undefined;
			hold.handoverTimer = undefined;
			// Its browser sign-in not back is the owner's tab; otherwise the client did not return.
			let cause =
				hold.machine === undefined && !await this.#auth.sessions.resolve(hold.ownerSessionId)
					? "login" as const
					: "client" as const;
			if (this.#holds.get(hold.channelId) !== hold || hold.link) return;
			console.warn(
				`chopin: remote Planner miss: the hand-over window of ${hold.channelId} ran out with `
					+ `${cause === "login" ? "its owner's sign-in not back" : "its client not back"}`,
			);
			if (hold.parked) this.#runs(hold, "down");
			else this.#startGrace(hold);
			this.#options.missed?.(hold.channelId, cause);
			this.#changed(hold.channelId);
		});
	}

	#runs(hold: Hold, outcome: RestoredRuns): void {
		if (this.#frozen) return;
		this.#options.restoredRuns?.(hold.channelId, outcome);
	}

	/** Keeps what a suspended link holds, for the process that takes over after a crash. */
	#saveRow(hold: Hold, link: AgentLink): void {
		let store = this.#options.store;
		if (!store || this.#frozen) return;
		let { ownerSessionId, machineId, machine } = hold;
		let row: PlannerLinkHold = {
			channelId: hold.channelId,
			userId: hold.userId,
			login: hold.login,
			...(machineId === undefined ? { ownerSessionId } : { machineId, machine: machine! }),
			generation: hold.generation,
			sessions: link.snapshot(),
			suspendedAt: this.#auth.clock(),
		};
		hold.persisted = true;
		this.#writeRow(hold.channelId, () => store.put(row));
	}

	/** Removes the row of a hold that a live link backs again or that ended. */
	#forgetRow(hold: Hold): void {
		let store = this.#options.store;
		if (!store || this.#frozen || !hold.persisted) return;
		hold.persisted = false;
		this.#writeRow(hold.channelId, () => store.delete(hold.channelId));
	}

	#writeRow(channelId: string, write: () => Promise<void>): void {
		let next = (this.#rows.get(channelId) ?? Promise.resolve()).then(write).catch(error =>
			console.error("[agent] keeping a remote Planner's link state failed:", error)
		);
		this.#rows.set(channelId, next);
		void next.then(() => {
			if (this.#rows.get(channelId) === next) this.#rows.delete(channelId);
		});
	}

	#changed(channelId: string): void {
		if (this.#frozen) return;
		let planner = this.status(channelId);
		for (let listener of this.#listeners) {
			try {
				listener(channelId, planner);
			} catch (error) {
				console.error("[agent] reporting the Planner attachment failed:", error);
			}
		}
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
		message: `A repository writer reset this document's connection, so ${login} is no longer `
			+ `connected. Connect again to resume.`,
	};
}

function documentEndedRefusal(): AttachRefusal {
	return {
		ok: false,
		code: "document-archived",
		message: "This document was archived or deleted, so its connection was released.",
	};
}

function attachedRefusal(hold: Hold): AttachRefusal {
	let message = hold.link
		? `${hold.login} is connected to this document. A document has one agent connected at a time.`
		: !hold.releaseAt
		? `${hold.login} is connected to this document, and its connection dropped. Its work is kept `
			+ "until it reconnects. A document has one agent connected at a time."
		: `${hold.login} disconnected from this document and keeps it until `
			+ `${hold.releaseAt.toISOString()} unless they connect again. A document has one agent connected at a time.`;
	return { ok: false, code: "planner-attached", message };
}

function signInRefusal(origin: string, login: string): AttachRefusal {
	return {
		ok: false,
		code: "sign-in-required",
		message: `Sign in to Chopin at ${origin} in a browser as ${login}, then connect again. `
			+ `Repository tools act with that sign-in.`,
	};
}

/** Why a hold's login ended: a browser sign-in, or `ended` false when it never began. */
function endedRefusal(origin: string, hold: Hold, ended = true): AttachRefusal {
	if (hold.machine !== undefined) return machineEndedRefusal(hold.machine, hold.login);
	return ended ? signInEndedRefusal(origin, hold.login) : signInRefusal(origin, hold.login);
}

function machineEndedRefusal(machine: string, login: string): AttachRefusal {
	return {
		ok: false,
		code: "access-revoked",
		message: `The paired machine ${machine} that connected ${login} to this document was `
			+ `disconnected from Chopin or must be paired again, so the connection was released. `
			+ "Run `chopin pair` on it, then connect again.",
	};
}

function signInEndedRefusal(origin: string, login: string): AttachRefusal {
	return {
		ok: false,
		code: "sign-in-required",
		message: `The Chopin browser sign-in that connected ${login} to this document ended, so the `
			+ `connection was released. Sign in to Chopin at ${origin} in a browser as ${login}, then `
			+ `connect again.`,
	};
}
