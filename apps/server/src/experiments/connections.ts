import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Source } from "@chopin/experiment";
import { fail, fingerprint } from "./service";

/** What a connector says about itself when it asks to pair; a checkout is optional. */
export type PairingInput = Partial<Omit<Source, "repositoryId">> & { label: string };
/**
 * One owner's paired machine, connected. Connector protocol 5 and up serves every repository its
 * owner can push to, checked per document as its work is claimed; an older connector connects
 * exactly one checkout and serves only that repository.
 */
export type Connection = {
	id: string;
	owner: string;
	login: string;
	/** The paired machine that connected; revoking it ends the connection. */
	machineId: string;
	label: string;
	/** The checkouts it said it has, one per repository; an older connector's only one. */
	checkouts: Source[];
	/** Whether it takes work in any repository, cloning one it has no checkout of. */
	anyRepository: boolean;
	expiresAt: number;
	/**
	 * The owner let Chopin start work on this laptop by itself (rebuilds and prototypes), when
	 * pairing it. Without it only work a person presses Build or Run for reaches the connection.
	 * Stored with the machine, so a reconnect keeps it.
	 */
	autoRun?: boolean;
	/** The chopin release that opened it, when it said; known only while it is connected. */
	version?: string;
	/**
	 * The connector protocol it spoke as it connected; 4 and up can run Planners on request, 5 and
	 * up serve any repository.
	 */
	protocol?: number;
	/** What the connector said about its machine as it connected. */
	about?: About;
};

/** A connected machine as its owner sees it in Chopin; every part is optional. */
export type About = {
	hostname?: string;
	platform?: { os: string; arch: string };
	service?: boolean;
	planner?: boolean;
	/** It has a Planner command, so it can run the Planner of a document it is chosen for. */
	plannerCommand?: boolean;
	agent?: { name: string; version?: string };
};
/** The browser's approval of a pairing, waiting for GitHub to authorize the machine. */
export type Approval = {
	owner: string;
	login: string;
	autoRun: boolean;
	repositoryId?: string;
};
type Pending = {
	id: string;
	input: PairingInput;
	proof: string;
	/** Shown by both the connector and the pairing page so a person can cross-check them. */
	code: string;
	expiresAt: number;
	approval?: Approval;
	machineId?: string;
	/** The machine token, handed once to the connector that holds the pairing secret. */
	token?: string;
};
export type Grant = {
	connectionId: string;
	run?: { id: string; documentId: string; generation: number; kind?: "implementation" | "rebuild" };
};

/** A connector that stops polling is forgotten this long after it was last heard from. */
const CONNECTION_MS = 90_000;
/** Connectors poll at least every 20 seconds while idle and heartbeat every 10 while working. */
const FRESH_MS = 45_000;

/** The first connector protocol whose connection is the machine rather than one checkout. */
export const ANY_REPOSITORY_PROTOCOL = 5;
/**
 * The first connector protocol whose build heartbeats and reports name the document, so a server
 * that restarted can find the build again and its machine can carry on with it.
 */
export const RESUME_PROTOCOL = 6;

/** A build's run, as its durable credential names it. */
export type DurableRun = { id: string; documentId: string; kind: "implementation" | "rebuild" };
const RUN_CONTEXT = "chopin:run-credential:v1";
const RUN_PREFIX = "chopin_r_";
/** An HMAC-SHA256 signature in unpadded base64url. */
const SIGNATURE_LENGTH = 43;

/** Whether a connection may take work in a repository. */
export function serves(connection: Connection, repositoryId: string) {
	return connection.anyRepository
		|| connection.checkouts.some(value => value.repositoryId === repositoryId);
}

/** The checkout a connection said it has of a repository, if any. */
export function checkoutOf(connection: Connection, repositoryId: string) {
	return connection.checkouts.find(value => value.repositoryId === repositoryId);
}

/** Every repository's connector waits on this key too, when it serves any repository. */
const ANY = "*";

/** How many live connections one owner may have at once. */
const OWNER_CONNECTIONS = 32;
/** How many runs' documents a process remembers, newest first, so a moved run can be found. */
const RUNS = 1000;
/** How long a process remembers a connection that ended, to tell it from one it never knew. */
const ENDED_MS = 60 * 60_000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function confirmation() {
	let bytes = randomBytes(8);
	let code = [...bytes].map(byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class Connections {
	#pending = new Map<string, Pending>();
	#connections = new Map<string, Connection>();
	#tokens = new Map<string, Grant>();
	/** Tokens of revoked machines' connections, so they keep saying why instead of vanishing. */
	#revoked = new Map<string, string>();
	#runTokens = new Map<string, string>();
	/** Each run's document, by run id, for the newest runs this process handed out. */
	#runs = new Map<string, string>();
	/** When each connection that ended in the last hour ended, by id. */
	#ended = new Map<string, number>();
	#waiters = new Map<string, Set<() => void>>();
	#builds = new Map<string, string>();
	/** Documents whose builds wait behind a connection's current one, first queued first. */
	#queued = new Map<string, string[]>();
	#used = new Map<string, string>();
	/** Each person's machine for a document, keyed by document and person; none is automatic. */
	#choices = new Map<string, string>();
	/** Each person's favorite machine, which Automatic prefers, by person. */
	#favorites = new Map<string, string>();
	/** False from unread() until restore(): the stored choices could not be read yet. */
	#choicesRead = true;
	#locks = new Map<string, Promise<unknown>>();
	/** What each machine's newest connection said about it, kept once it disconnects. */
	#about = new Map<string, About>();
	/** Called once with each connection that ends: disconnected, expired, or its machine revoked. */
	onEnded?: (connection: Connection) => void;
	/** Signs build run credentials so they can be checked again after a restart; none without a key. */
	#runKey: Buffer | undefined;
	constructor(
		private now = () => Date.now(),
		/** The deployment's SESSION_ENCRYPTION_KEY, from which build run credentials are derived. */
		key?: Uint8Array,
	) {
		this.#runKey = key
			? Buffer.from(hkdfSync("sha256", key, "", RUN_CONTEXT, 32))
			: undefined;
	}
	/** Whether build run credentials outlive this process, so a build can resume after a restart. */
	get durable() {
		return !!this.#runKey;
	}
	#sign(payload: string) {
		return createHmac("sha256", this.#runKey!).update(payload).digest();
	}
	/**
	 * A build's run credential: its run, signed with a key derived from the deployment's own, so a
	 * restarted server can check it without having stored it. The build's state still decides
	 * whether it is accepted: it ends with the build.
	 */
	#durableToken(run: DurableRun) {
		let payload = Buffer.from([run.documentId, run.id, run.kind].join("\n")).toString("base64url");
		// The signature first, at its fixed length, keeps the whole token one base64url word.
		return `${RUN_PREFIX}${this.#sign(payload).toString("base64url")}${payload}`;
	}
	/** The run a durable build credential names, when this deployment signed it. */
	durableRun(token: string): DurableRun | undefined {
		if (!this.#runKey || !token.startsWith(RUN_PREFIX) || token.length > 512) return undefined;
		let body = token.slice(RUN_PREFIX.length);
		let signature = body.slice(0, SIGNATURE_LENGTH);
		let payload = body.slice(SIGNATURE_LENGTH);
		if (!payload || !/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
		let given = Buffer.from(signature, "base64url");
		let expected = this.#sign(payload);
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		let [documentId, id, kind, rest] = Buffer.from(payload, "base64url").toString("utf8")
			.split("\n");
		if (!documentId || !id || rest !== undefined) return undefined;
		if (kind !== "implementation" && kind !== "rebuild") return undefined;
		return { documentId, id, kind };
	}
	/**
	 * Accept a durable build credential this process has not seen, as after a restart, for the
	 * connection that now holds its build.
	 */
	adopt(token: string, connectionId: string, run: DurableRun) {
		if (!this.#connections.has(connectionId)) return;
		this.#runTokens.set(`${connectionId}:${run.id}:1:${run.kind}`, token);
		this.#tokens.set(fingerprint(token), {
			connectionId,
			run: { id: run.id, documentId: run.documentId, generation: 1, kind: run.kind },
		});
		this.#remember(run.id, run.documentId);
	}
	/** Whether this process already holds a credential, or refused it. */
	holds(token: string) {
		let key = fingerprint(token);
		return this.#tokens.has(key) || this.#revoked.has(key);
	}
	create(input: PairingInput) {
		this.sweep();
		if (this.#pending.size >= 100) fail("pairing-capacity");
		let secret = randomBytes(32).toString("base64url");
		let id = crypto.randomUUID();
		let code = confirmation();
		this.#pending.set(id, {
			id,
			input,
			proof: fingerprint(secret),
			code,
			expiresAt: this.now() + 300_000,
		});
		return { id, secret, code };
	}
	pending(id: string) {
		let value = this.#pending.get(id);
		if (!value || value.expiresAt <= this.now()) fail("pairing-expired");
		return value;
	}
	/** Record who approved a pairing in the browser; another account cannot take it over. */
	approve(id: string, approval: Approval) {
		let value = this.pending(id);
		if (value.approval && value.approval.owner !== approval.owner) fail("already-paired");
		if (!value.machineId) value.approval = approval;
		return value;
	}
	/** The machine GitHub authorized for an approved pairing, and its token for the connector. */
	paired(id: string, machineId: string, token: string) {
		let value = this.pending(id);
		value.machineId = machineId;
		value.token = token;
	}
	claim(id: string, secret: string) {
		let value = this.pending(id);
		if (value.proof !== fingerprint(secret)) fail("pairing-forbidden");
		return value.token ? { token: value.token } : { waiting: true as const };
	}
	/**
	 * A paired machine comes online with the checkouts it has: protocol 5 and up for any repository
	 * its owner can push to, an older connector for its one checkout's. Its token lives only in this
	 * process.
	 */
	open(
		machine: {
			id: string;
			owner: string;
			login: string;
			autoRun: boolean;
			version?: string;
			protocol?: number;
		},
		label: string,
		checkouts: Source[],
		about: About = {},
	) {
		this.sweep();
		let anyRepository = (machine.protocol ?? 1) >= ANY_REPOSITORY_PROTOCOL;
		let owned = [...this.#connections.values()].filter(value =>
			value.owner === machine.owner && value.expiresAt > this.now()
		);
		if (
			owned.length >= OWNER_CONNECTIONS
			|| !anyRepository
				&& checkouts.some(checkout =>
					owned.filter(value => serves(value, checkout.repositoryId)).length >= 8
				)
		) fail("connection-limit");
		let connection: Connection = {
			id: crypto.randomUUID(),
			owner: machine.owner,
			login: machine.login,
			machineId: machine.id,
			label,
			checkouts,
			anyRepository,
			expiresAt: this.now() + CONNECTION_MS,
			autoRun: machine.autoRun,
			...(machine.version ? { version: machine.version } : {}),
			...(machine.protocol !== undefined ? { protocol: machine.protocol } : {}),
			about,
		};
		let token = randomBytes(32).toString("base64url");
		this.#connections.set(connection.id, connection);
		this.#about.set(machine.id, about);
		this.#tokens.set(fingerprint(token), { connectionId: connection.id });
		return { connection, token };
	}
	/** Live connections of one paired machine. */
	machine(machineId: string) {
		return [...this.#connections.values()].filter(value =>
			value.machineId === machineId && value.expiresAt > this.now()
		);
	}
	/** What a machine last said about itself while this server ran, connected or not. */
	about(machineId: string): About | undefined {
		return this.#about.get(machineId);
	}
	/** Whether a token is a run's, which the coding agent itself presents. */
	run(token: string) {
		return !!this.#tokens.get(fingerprint(token))?.run || !!this.durableRun(token);
	}
	lookup(token: string) {
		let refused = this.#revoked.get(fingerprint(token));
		if (refused) fail(refused);
		let grant = this.#tokens.get(fingerprint(token));
		let connection = grant && this.get(grant.connectionId);
		if (!grant || !connection) fail("connection-unavailable");
		return { grant, connection };
	}
	get(id: string) {
		let value = this.#connections.get(id);
		return value && value.expiresAt > this.now() ? value : undefined;
	}
	touch(connection: Connection) {
		connection.expiresAt = this.now() + CONNECTION_MS;
	}
	/**
	 * Heard from within about two of its long-poll or heartbeat intervals. A silent connection
	 * stays usable until it expires, but new work should not be queued on it.
	 */
	fresh(connection: Connection) {
		return connection.expiresAt - CONNECTION_MS > this.now() - FRESH_MS;
	}
	/** Live connections that serve a repository, most recently heard from first. */
	list(repositoryId: string, owner?: string) {
		return [...this.#connections.values()].filter(value =>
			serves(value, repositoryId) && value.expiresAt > this.now()
			&& (owner === undefined || value.owner === owner)
		).sort((a, b) => b.expiresAt - a.expiresAt);
	}
	/** Remember which document holds the build a connection was last given. */
	assign(connectionId: string, documentId: string) {
		if (this.#connections.has(connectionId)) this.#builds.set(connectionId, documentId);
	}
	assigned(connectionId: string) {
		return this.#builds.get(connectionId);
	}
	/** Queue a document's build behind the other document's build a connection holds. */
	enqueue(connectionId: string, documentId: string) {
		if (!this.#connections.has(connectionId) || this.#builds.get(connectionId) === documentId) {
			return;
		}
		let queue = this.#queued.get(connectionId) ?? [];
		if (!queue.includes(documentId)) this.#queued.set(connectionId, [...queue, documentId]);
	}
	/** Documents whose builds wait for this connection, in the order they will start. */
	queued(connectionId: string): string[] {
		return [...(this.#queued.get(connectionId) ?? [])];
	}
	/**
	 * Forget a finished, deleted, or unreachable build so it cannot strand the connection. The
	 * next document queued behind it takes its place, and the connector is woken to claim it.
	 */
	release(connectionId: string, documentId: string) {
		let queue = this.#queued.get(connectionId) ?? [];
		if (this.#builds.get(connectionId) === documentId) {
			let [next, ...rest] = queue;
			if (next === undefined) {
				this.#builds.delete(connectionId);
				return;
			}
			this.#builds.set(connectionId, next);
			if (rest.length) this.#queued.set(connectionId, rest);
			else this.#queued.delete(connectionId);
			let connection = this.#connections.get(connectionId);
			if (connection) this.wakeConnection(connection);
			return;
		}
		let rest = queue.filter(id => id !== documentId);
		if (rest.length) this.#queued.set(connectionId, rest);
		else this.#queued.delete(connectionId);
	}
	/** Remember the connection that last ran work for a document, to prefer it next time. */
	use(documentId: string, connectionId: string) {
		this.#used.set(documentId, connectionId);
	}
	/**
	 * `owner`'s live connections that serve a repository and may take their work on `documentId`:
	 * every machine of theirs on connector protocol 5 and up, whatever checkouts it has, and an
	 * older one connected for this repository. Whether the machine's owner can push to it is
	 * checked as the work is claimed. A chosen
	 * machine's connections only, so an offline choice leaves none rather than falling back to
	 * another machine. Automatic offers all of them: the owner's favorite machine first, then the
	 * one last used for the document.
	 */
	candidates(
		repositoryId: string,
		owner: string,
		documentId: string,
		/** Null asks what automatic would pick, whatever the person chose. */
		chosen: string | null | undefined = this.chosen(documentId, owner),
	) {
		// Until the stored choices are read, nobody knows which machine may take the work.
		if (!this.#choicesRead && chosen !== null) return [];
		let last = this.#used.get(documentId);
		let favorite = chosen ? undefined : this.#favorites.get(owner);
		return this.list(repositoryId, owner).filter(value => !chosen || value.machineId === chosen)
			.sort((a, b) =>
				Number(b.machineId === favorite) - Number(a.machineId === favorite)
				|| Number(b.id === last) - Number(a.id === last)
			);
	}
	/** Whether a connection may take its owner's work on `documentId`, as candidates() decides. */
	allows(documentId: string, connection: Connection) {
		if (!this.#choicesRead) return false;
		let chosen = this.chosen(documentId, connection.owner);
		return chosen === undefined || connection.machineId === chosen;
	}
	/**
	 * Whether the stored choices have been read. Until they are, no connection takes anyone's
	 * work: a choice that cannot be read is never taken for automatic.
	 */
	get choicesRead() {
		return this.#choicesRead;
	}
	/** The stored choices are not read yet; work waits for restore(). */
	unread() {
		this.#choicesRead = false;
	}
	/** The stored choices and favorites, read; work may be routed again. */
	restore(
		choices: { channelId: string; userId: string; machineId: string }[],
		favorites: { userId: string; machineId: string }[] = [],
	) {
		for (let value of choices) this.choose(value.channelId, value.userId, value.machineId);
		for (let value of favorites) this.favor(value.userId, value.machineId);
		this.#choicesRead = true;
	}
	/** The machine `owner` prefers when a document is on Automatic, if any. */
	favorite(owner: string) {
		return this.#favorites.get(owner);
	}
	/** Remember a stored favorite; without a machine, the person has none. */
	favor(owner: string, machineId?: string) {
		if (machineId) this.#favorites.set(owner, machineId);
		else this.#favorites.delete(owner);
	}
	/** The machine `owner` chose for `documentId`, or undefined for automatic. */
	chosen(documentId: string, owner: string) {
		return this.#choices.get(`${documentId}\n${owner}`);
	}
	/** Remember a stored choice; without a machine, the person is back to automatic. */
	choose(documentId: string, owner: string, machineId?: string) {
		let key = `${documentId}\n${owner}`;
		if (machineId) this.#choices.set(key, machineId);
		else this.#choices.delete(key);
	}
	/** The machines people chose for a document's work, one per person at most. */
	chosenFor(documentId: string) {
		return [...this.#choices].filter(([key]) => key.startsWith(`${documentId}\n`))
			.map(([, machineId]) => machineId);
	}
	/** The documents whose work someone chose a machine for. */
	choosing(machineId: string) {
		return [...this.#choices].filter(([, value]) => value === machineId).map(([key]) => {
			let [documentId, owner] = key.split("\n") as [string, string];
			return { documentId, owner };
		});
	}
	/** A revoked machine is nobody's choice, or favorite, any more. */
	unchoose(machineId: string) {
		for (let [key, value] of this.#choices) if (value === machineId) this.#choices.delete(key);
		for (let [key, value] of this.#favorites) if (value === machineId) this.#favorites.delete(key);
	}
	runToken(
		connectionId: string,
		documentId: string,
		id: string,
		generation: number,
		kind?: "implementation" | "rebuild",
	) {
		let key = `${connectionId}:${id}:${generation}:${kind ?? "experiment"}`;
		let existing = this.#runTokens.get(key);
		if (existing) return existing;
		// A build's credential can be checked again after a restart; an investigation's cannot.
		let token = kind && this.#runKey
			? this.#durableToken({ id, documentId, kind })
			: randomBytes(32).toString("base64url");
		this.#runTokens.set(key, token);
		this.#tokens.set(fingerprint(token), {
			connectionId,
			run: { id, documentId, generation, ...(kind ? { kind } : {}) },
		});
		this.#remember(id, documentId);
		return token;
	}
	#remember(id: string, documentId: string) {
		this.#runs.delete(id);
		this.#runs.set(id, documentId);
		for (let old of this.#runs.keys()) {
			if (this.#runs.size <= RUNS) break;
			this.#runs.delete(old);
		}
	}
	/** The document of a run this process handed out, whichever connection holds it now. */
	runDocument(id: string) {
		return this.#runs.get(id);
	}
	/**
	 * Whether this process opened the connection, connected or ended within the last hour. One it
	 * never knew was opened before the server restarted.
	 */
	known(id: string) {
		return this.#connections.has(id) || this.#ended.has(id);
	}
	/**
	 * Move a run from one connection of a machine to a newer one of the same machine: its document's
	 * assignment, and the run credential the agent holds, which keeps working once the old
	 * connection ends.
	 */
	rebind(from: string, to: Connection, documentId: string, runId: string) {
		if (this.#builds.get(from) === documentId) this.#builds.delete(from);
		// Ending the old MCP session already removed its assignment. One the new connection holds
		// for another document is that document's, and stays.
		if (this.#builds.get(to.id) === undefined) this.assign(to.id, documentId);
		if (this.#used.get(documentId) === from) this.#used.set(documentId, to.id);
		for (let [key, token] of this.#runTokens) {
			if (!key.startsWith(`${from}:${runId}:`)) continue;
			this.#runTokens.delete(key);
			this.#runTokens.set(`${to.id}:${key.slice(from.length + 1)}`, token);
		}
		for (let grant of this.#tokens.values()) {
			if (grant.connectionId === from && grant.run?.id === runId) grant.connectionId = to.id;
		}
	}
	revoke(id: string) {
		let connection = this.#connections.get(id);
		this.#connections.delete(id);
		if (connection) this.#ended.set(id, this.now());
		this.#builds.delete(id);
		this.#queued.delete(id);
		for (let [document, used] of this.#used) if (used === id) this.#used.delete(document);
		for (let key of this.#runTokens.keys()) {
			if (key.startsWith(`${id}:`)) this.#runTokens.delete(key);
		}
		for (let [key, grant] of this.#tokens) if (grant.connectionId === id) this.#tokens.delete(key);
		if (connection) {
			this.wakeConnection(connection);
			this.onEnded?.(connection);
		}
	}
	revokeMachine(machineId: string, code = "machine-revoked") {
		for (let connection of this.#connections.values()) {
			if (connection.machineId !== machineId) continue;
			for (let [key, grant] of this.#tokens) {
				if (grant.connectionId === connection.id) this.#revoked.set(key, code);
			}
			this.revoke(connection.id);
		}
	}
	sweep() {
		for (let [id, pending] of this.#pending) {
			if (pending.expiresAt <= this.now()) this.#pending.delete(id);
		}
		for (let [id, connection] of this.#connections) {
			if (connection.expiresAt <= this.now()) this.revoke(id);
		}
		for (let [id, at] of this.#ended) if (at <= this.now() - ENDED_MS) this.#ended.delete(id);
	}
	/** Wake every connector waiting for work in a repository, and every one serving any. */
	wake(repositoryId: string) {
		for (let key of new Set([repositoryId, ANY])) {
			for (let resolve of this.#waiters.get(key) ?? []) resolve();
		}
	}
	/** Wake the connectors that wait on what this connection serves. */
	wakeConnection(connection: Connection) {
		if (connection.anyRepository) this.wake(ANY);
		for (let checkout of connection.checkouts) this.wake(checkout.repositoryId);
	}
	/** Wait, at most 20 seconds, for work this connection may take. */
	wait(connection: Connection, signal: AbortSignal) {
		let keys = connection.anyRepository
			? [ANY]
			: connection.checkouts.map(checkout => checkout.repositoryId);
		return new Promise<void>(resolve => {
			let finish = () => {
				clearTimeout(timer);
				for (let key of keys) {
					let set = this.#waiters.get(key);
					set?.delete(finish);
					if (set && !set.size) this.#waiters.delete(key);
				}
				signal.removeEventListener("abort", finish);
				resolve();
			};
			let timer = setTimeout(finish, 20_000);
			for (let key of keys) {
				let set = this.#waiters.get(key) ?? new Set();
				this.#waiters.set(key, set);
				set.add(finish);
			}
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}
	async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
		let next = (this.#locks.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
		this.#locks.set(id, next);
		try {
			return await next;
		} finally {
			if (this.#locks.get(id) === next) this.#locks.delete(id);
		}
	}
}
