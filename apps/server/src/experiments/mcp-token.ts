/**
 * MCP tokens: what a launch on a paired machine hands its own child processes (a backend's
 * stages, subagents and pool workers, a build's extensions) so they can use Chopin's tools at
 * `/mcp`, without the GitHub token, which is the GitHub App's and only reaches GitHub, and without
 * the credential the launch itself holds. A Planner credential can open the document's agent link
 * and a run credential can report the run's lifecycle; an MCP token can do neither. It reaches
 * only `/mcp`, only the documents of the launch it was minted for, and only while that launch
 * lasts.
 *
 * A token names its launch and is signed with a key derived from the deployment's own, so a server
 * that restarted checks it without having stored it. Each use asks again whether the launch is
 * live: a Planner's token stands only while the Planner credential it was minted from is stored
 * and unexpired (the Planner stopped on the machine, or the machine unpaired, deletes it), and a
 * run's only while Chopin still has the run on that machine.
 */

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { fail } from "./service";

const CONTEXT = "chopin:mcp-token:v1";
const PREFIX = "chopin_mcp_";
/** An HMAC-SHA256 signature in unpadded base64url. */
const SIGNATURE_LENGTH = 43;
/** How long a run's MCP token lasts; the connector asks for another before it ends. */
export const RUN_MCP_TOKEN_MS = 60 * 60_000;

/** The launch a token was minted for. */
export type McpLaunch =
	| {
		kind: "planner";
		machineId: string;
		documentId: string;
		/** The SHA-256 of the Planner credential it was minted from, in base64url. */
		credential: string;
		/** Who it acts as: the machine's owner. */
		userId: string;
		expiresAt: number;
	}
	| {
		kind: "run";
		machineId: string;
		documentId: string;
		runId: string;
		/** Who it acts as: the person who started the run. */
		userId: string;
		expiresAt: number;
	};

/** The SHA-256 a Planner credential is stored under. */
export function credentialDigest(token: string): Uint8Array {
	return new Uint8Array(createHash("sha256").update(token).digest());
}

/** Whether a bearer is shaped as an MCP token rather than a GitHub token. */
export function claimsMcpToken(token: string): boolean {
	return token.startsWith(PREFIX);
}

export class McpTokens {
	#key: Buffer;

	/** `key` is the deployment's SESSION_ENCRYPTION_KEY; the signing key is derived from it. */
	constructor(key: Uint8Array) {
		this.#key = Buffer.from(hkdfSync("sha256", key, "", CONTEXT, 32));
	}

	#sign(payload: string) {
		return createHmac("sha256", this.#key).update(payload).digest();
	}

	mint(launch: McpLaunch): string {
		let fields = launch.kind === "planner"
			? ["planner", launch.machineId, launch.documentId, launch.credential]
			: ["run", launch.machineId, launch.documentId, launch.runId];
		let payload = Buffer.from(
			[...fields, launch.userId, String(launch.expiresAt)].join("\n"),
		).toString("base64url");
		// The signature first, at its fixed length, keeps the whole token one base64url word.
		return `${PREFIX}${this.#sign(payload).toString("base64url")}${payload}`;
	}

	/** The launch an unexpired token this deployment signed names; anything else is refused. */
	read(token: string, now: number): McpLaunch | undefined {
		if (!claimsMcpToken(token) || token.length > 1024) return undefined;
		let body = token.slice(PREFIX.length);
		if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
		let given = Buffer.from(body.slice(0, SIGNATURE_LENGTH), "base64url");
		let payload = body.slice(SIGNATURE_LENGTH);
		let expected = this.#sign(payload);
		if (!payload || given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return undefined;
		}
		let [kind, machineId, documentId, which, userId, expires, rest] = Buffer.from(
			payload,
			"base64url",
		).toString("utf8").split("\n");
		let expiresAt = Number(expires);
		if (
			!machineId || !documentId || !which || !userId || rest !== undefined
			|| !Number.isSafeInteger(expiresAt) || expiresAt <= now
		) return undefined;
		if (kind === "planner") {
			return { kind, machineId, documentId, credential: which, userId, expiresAt };
		}
		if (kind === "run") return { kind, machineId, documentId, runId: which, userId, expiresAt };
		return undefined;
	}
}

/** What minting checks a launch's own credential against. */
export type McpTokenSources = {
	tokens: McpTokens;
	now(): number;
	/** The stored Planner credential with this digest while it is unexpired. */
	plannerCredential(digest: Uint8Array): Promise<
		{ machineId: string; channelId: string; expiresAt: Date } | undefined
	>;
	/** The run a run credential this server issued names, and the machine it was issued to. */
	runCredential(
		token: string,
	): { runId: string; documentId: string; machineId?: string } | undefined;
	/** The run as Chopin has it while it is live: who started it and the machine it went to. */
	run(id: string, documentId: string): Promise<
		{ starter: string; documentId?: string; machineId?: string } | undefined
	>;
};

/**
 * An MCP token for the launch a paired machine's own credential is for: `planner`, a Planner
 * credential issued to this machine, or `run`, a run credential of a run Chopin has on it now.
 * A Planner's token lasts as long as its credential; a run's an hour.
 */
export async function mintMcpToken(
	sources: McpTokenSources,
	machine: { id: string; userId: string },
	from: { planner: string } | { run: string },
): Promise<{ token: string; expiresAt: number }> {
	let now = sources.now();
	if ("planner" in from) {
		let digest = credentialDigest(from.planner);
		let issued = await sources.plannerCredential(digest);
		if (!issued || issued.machineId !== machine.id || issued.expiresAt.getTime() <= now) {
			fail("credential-invalid", "That Planner credential isn't one Chopin gave this machine.");
		}
		let expiresAt = issued.expiresAt.getTime();
		let token = sources.tokens.mint({
			kind: "planner",
			machineId: machine.id,
			documentId: issued.channelId,
			credential: Buffer.from(digest).toString("base64url"),
			userId: machine.userId,
			expiresAt,
		});
		return { token, expiresAt };
	}
	let named = sources.runCredential(from.run);
	if (!named || (named.machineId !== undefined && named.machineId !== machine.id)) {
		fail("credential-invalid", "That run credential isn't one Chopin gave this machine.");
	}
	let run = await sources.run(named.runId, named.documentId);
	if (
		!run || (run.machineId !== undefined && run.machineId !== machine.id)
		|| (run.documentId !== undefined && run.documentId !== named.documentId)
	) fail("run-unknown", "Chopin has no such run on this machine now.");
	let expiresAt = now + RUN_MCP_TOKEN_MS;
	let token = sources.tokens.mint({
		kind: "run",
		machineId: machine.id,
		documentId: named.documentId,
		runId: named.runId,
		userId: run.starter,
		expiresAt,
	});
	return { token, expiresAt };
}

/**
 * The launch an MCP token names, while that launch is live: its Planner credential still stored
 * and unexpired, or its run still Chopin's on that machine. Undefined otherwise.
 */
export async function liveMcpLaunch(
	sources: Omit<McpTokenSources, "runCredential">,
	token: string,
): Promise<McpLaunch | undefined> {
	let now = sources.now();
	let launch = sources.tokens.read(token, now);
	if (!launch) return undefined;
	if (launch.kind === "planner") {
		let issued = await sources.plannerCredential(
			new Uint8Array(Buffer.from(launch.credential, "base64url")),
		);
		return issued && issued.machineId === launch.machineId
				&& issued.channelId === launch.documentId && issued.expiresAt.getTime() > now
			? launch
			: undefined;
	}
	let run = await sources.run(launch.runId, launch.documentId);
	return run && run.starter === launch.userId
			&& (run.machineId === undefined || run.machineId === launch.machineId)
			&& (run.documentId === undefined || run.documentId === launch.documentId)
		? launch
		: undefined;
}
