/**
 * The Planner's `create_document`: a new top-level document, in the same repository and base
 * branch as the one whose turn asked, with its own Chat, Decisions and Planner session.
 *
 * The person whose message drives the turn is the creator. Their own browser login is asked
 * again for write access to the repository, as `chat:send` is; the Planner's credential never
 * authorizes a new document by itself. A retried call with the same key returns the document the
 * first call made, from the base that call recorded, and creates and starts nothing; it only posts
 * the Chat line if the first call could not save it. A document is stored, with the creating
 * document's model choice, before its Chat line, the sidebar or its own Planner hear of it.
 */
import { deterministicChannelId } from "../channels/id";
import { BRIEF, prepare } from "../mcp/create";
import { MAX_TITLE_LENGTH } from "../channels/title";

import type { AuthenticatedSession } from "../auth/session";
import type { HostedRepository } from "./repository";
import type { InvokePlannerError } from "../mcp";
import type { Brief, CreateDocumentInput, CreationOrigin } from "../mcp/create";
import type { CreatedDocument, DocumentCreator, PlannerInvocation } from "../mcp/hosted";
import type { Repository as GitHubRepository } from "../github/client";
import type { ChannelRecord, CreateChannel } from "../storage/model";
import type { Issue } from "@chopin/dialect";

export const MAX_INSTRUCTION_BYTES = 64 * 1_024;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

export type NewDocumentArguments = {
	idempotencyKey: string;
	title: string;
	brief: Brief;
	document: string;
	instruction?: string;
};

export const NEW_DOCUMENT_SCHEMA = {
	type: "object",
	properties: {
		idempotencyKey: {
			type: "string",
			pattern: KEY.source,
			description: "A stable key for this one new document, such as auth-settings-page. Reuse "
				+ "it when retrying the same call; a retry returns the document already made.",
		},
		title: { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH },
		brief: BRIEF,
		document: {
			type: "string",
			minLength: 1,
			description: "The new document's whole first draft in the document dialect, as `read_plan` "
				+ "shows a document's source.",
		},
		instruction: {
			type: "string",
			minLength: 1,
			description: "Optional. What the new document's own Planner should do first. It is posted "
				+ "in the new document's Chat as the requesting person's message and starts its turn.",
		},
	},
	required: ["idempotencyKey", "title", "brief", "document"],
	additionalProperties: false,
};

/** The tool's arguments, checked; throws with a sentence the model can act on. */
export function newDocumentArguments(raw: unknown): NewDocumentArguments {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("create_document arguments must be an object");
	}
	let args = raw as Record<string, unknown>;
	let allowed = new Set(["idempotencyKey", "title", "brief", "document", "instruction"]);
	let unknown = Object.keys(args).find(key => !allowed.has(key));
	if (unknown) throw new Error(`create_document does not take \`${unknown}\``);
	if (typeof args.idempotencyKey !== "string" || !KEY.test(args.idempotencyKey)) {
		throw new Error("idempotencyKey must be 8 to 64 letters, digits, `-` or `_`");
	}
	if (typeof args.title !== "string" || !args.title.trim()) {
		throw new Error("title must be non-empty text");
	}
	if (typeof args.document !== "string" || !args.document.trim()) {
		throw new Error("document must be the new document's non-empty source");
	}
	if (
		Object.hasOwn(args, "instruction")
		&& (typeof args.instruction !== "string" || !args.instruction.trim()
			|| Buffer.byteLength(args.instruction, "utf8") > MAX_INSTRUCTION_BYTES)
	) throw new Error("instruction must be non-empty text of at most 64 KiB");
	return {
		idempotencyKey: args.idempotencyKey,
		title: args.title,
		brief: args.brief as Brief,
		document: args.document,
		...(typeof args.instruction === "string" ? { instruction: args.instruction } : {}),
	};
}

export type NewDocumentRequest = {
	/** The document whose turn asked. */
	sourceId: string;
	creator: { userId: string; handle: string; claimantSessionId?: string };
	arguments: NewDocumentArguments;
	/**
	 * Saves, then shows, the creating Chat's line naming a new document, unless that Chat already
	 * holds it. Called once the document is stored, and again by a retry.
	 */
	announce: (document: { id: string; title: string; path: string }) => Promise<void>;
	signal?: AbortSignal;
};

export type NewDocumentDeps = {
	channel: (id: string) => Promise<ChannelRecord | undefined>;
	deleting: (id: string) => boolean;
	/** The creator's own live browser login, preferring the one that sent the message. */
	login: (userId: string, sessionId?: string) => Promise<AuthenticatedSession | undefined>;
	/** The repository as that login reads it on GitHub now, or undefined when it cannot. */
	repository: (
		login: AuthenticatedSession,
		owner: string,
		name: string,
	) => Promise<GitHubRepository | undefined>;
	branchHead: (
		login: AuthenticatedSession,
		owner: string,
		name: string,
		branch: string,
	) => Promise<string>;
	/** The base a document was created from, when it records one. */
	origin: (channelId: string) => Promise<CreationOrigin | undefined>;
	/** The creation stored under a new document's id, when an earlier call already made it. */
	created: (channelId: string) => Promise<CreationOrigin | undefined>;
	create: (
		creator: DocumentCreator,
		input: CreateDocumentInput,
		instructed: boolean,
	) => Promise<CreatedDocument>;
	/**
	 * The creating document's model and thinking level, chosen again by the creator, to be stored
	 * with the new document in the transaction that creates it; undefined when it has none.
	 */
	modelChoice: (from: string, userId: string) => Promise<CreateChannel["modelChoice"]>;
	invoke: (input: PlannerInvocation) => Promise<InvokePlannerError | undefined>;
	/** What a refused instruction says, for refusals that have their own words. */
	refusal?: (
		code: InvokePlannerError,
		channel: ChannelRecord,
		url: string,
	) => Promise<string | undefined>;
	/** This deployment's origin, for the URL the model is given. */
	appOrigin: string;
};

export type NewDocumentResult =
	| {
		ok: true;
		document: { id: string; title: string; url: string };
		/** True when an earlier call with this key made it; nothing new was created or started. */
		replayed?: true;
		/** False when the creating Chat's line naming it could not be saved; a retry posts it. */
		announced?: false;
		instruction?: { started: true } | { started: false; reason: string; message?: string };
		next: string;
	}
	| { ok: false; reason: string; message: string; issues?: Issue[] };

const REFUSALS: Record<string, string> = {
	"sign-in-required": "The person who asked has no live Chopin login in a browser, so their "
		+ "access can't be checked. Ask them to open Chopin and try again.",
	"repository-forbidden": "The person who asked can't write to this repository, so no document "
		+ "was created.",
	"document-unavailable": "This document is archived, deleted or closing, so it can't create "
		+ "others.",
	"idempotency-conflict": "Another document was already created with this idempotencyKey and "
		+ "different content. Use a new key for a different document.",
	"title-taken": "The repository already has a document with this title. Choose another title.",
	"invalid-document": "The document is not valid in the dialect. Fix the issues and retry with "
		+ "the same idempotencyKey.",
	"visuals-required": "Add the required diagrams or tables beside the named passages and retry "
		+ "with the same idempotencyKey; nothing was saved.",
	unavailable: "The document could not be created now. Retry with the same idempotencyKey.",
};

function refused(reason: string, issues?: Issue[]): NewDocumentResult {
	return {
		ok: false,
		reason,
		message: REFUSALS[reason] ?? REFUSALS.unavailable!,
		...(issues ? { issues } : {}),
	};
}

function writes(repository: GitHubRepository | undefined, id: string): boolean {
	return !!repository && repository.id === id
		&& (repository.permissions.push || repository.permissions.admin);
}

export async function createNewDocument(
	deps: NewDocumentDeps,
	request: NewDocumentRequest,
): Promise<NewDocumentResult> {
	let { creator, sourceId } = request;
	let args = request.arguments;
	let source = await deps.channel(sourceId);
	if (!source || source.archivedAt || deps.deleting(sourceId) || source.parentChannelId) {
		return refused("document-unavailable");
	}
	let login = await deps.login(creator.userId, creator.claimantSessionId);
	if (!login || login.user.id !== creator.userId) return refused("sign-in-required");
	let owner = source.repositoryOwner;
	let name = source.repositoryName;
	let repository = await deps.repository(login, owner, name);
	if (!repository || !writes(repository, source.repositoryId)) {
		return refused("repository-forbidden");
	}
	let idempotencyKey = `planner:${sourceId}:${args.idempotencyKey}`;
	let earlier = await deps.created(deterministicChannelId(source.repositoryId, idempotencyKey));
	let inherited = earlier ?? await deps.origin(sourceId);
	let base = inherited && (earlier || inherited.repository === `${owner}/${name}`)
		? { baseBranch: inherited.baseBranch, baseCommit: inherited.baseCommit }
		: undefined;
	if (!base) {
		let baseBranch = repository.defaultBranch;
		base = { baseBranch, baseCommit: await deps.branchHead(login, owner, name, baseBranch) };
	}
	let prepared = prepare({
		idempotencyKey,
		repository: `${owner}/${name}`,
		...base,
		title: args.title,
		brief: args.brief,
		plan: args.document,
	});
	if (!prepared) {
		return refused("invalid-document", [{
			code: "arguments",
			message: "title, brief and document must match the create_document schema",
			path: "root",
		}]);
	}
	if ("issues" in prepared) return refused("invalid-document", prepared.issues);
	let outcome = await deps.create(
		{
			user: login.user,
			repository,
			stillWrites: async () => {
				let current = await deps.login(creator.userId, creator.claimantSessionId);
				return !!current
					&& writes(await deps.repository(current, owner, name), source.repositoryId);
			},
			modelChoice: () => deps.modelChoice(sourceId, creator.userId),
			...(request.signal ? { signal: request.signal } : {}),
		},
		prepared.input,
		args.instruction !== undefined,
	);
	if (outcome.kind === "conflict") return refused("idempotency-conflict");
	if (outcome.kind === "title-taken") return refused("title-taken");
	if (outcome.kind === "forbidden") return refused("repository-forbidden");
	if (outcome.kind === "unavailable") return refused("unavailable");
	if (outcome.kind === "visuals-required") return refused("visuals-required", outcome.issues);
	let { channel } = outcome;
	let path = outcome.document.url;
	let url = new URL(path, deps.appOrigin).href;
	let document = { id: channel.id, title: channel.title, url };
	let announced = await request.announce({ id: channel.id, title: channel.title, path }).then(
		() => true,
		(err: unknown) => {
			console.error("[chat] could not post a new document's Chat line:", err);
			return false;
		},
	);
	let unsaved = announced ? {} : { announced: false as const };
	let retry = announced
		? ""
		: "Its line in this Chat could not be saved. Call create_document again with the same "
			+ "arguments to post it; nothing new is created. ";
	if (outcome.kind === "replayed") {
		return {
			ok: true,
			document,
			replayed: true,
			...unsaved,
			next: `${retry}An earlier call with this idempotencyKey made this document; nothing new `
				+ "was created or started.",
		};
	}
	if (args.instruction === undefined) {
		return {
			ok: true,
			document,
			...unsaved,
			next: `${retry}The document is in the sidebar and has its own Chat. Its Planner starts `
				+ "when someone writes to it there.",
		};
	}
	let hosted: HostedRepository = {
		id: repository.id,
		owner: repository.owner,
		name: repository.name,
		defaultBranch: repository.defaultBranch,
	};
	let code: InvokePlannerError | undefined;
	try {
		code = await deps.invoke({
			channel,
			repository: hosted,
			user: { id: login.user.id, login: login.user.login, avatarUrl: login.user.avatarUrl },
			session: login,
			instruction: args.instruction,
		});
	} catch (err) {
		console.error("[chat] a new document's first instruction failed:", err);
		code = "planner-unavailable";
	}
	if (code) {
		let message = await deps.refusal?.(code, channel, url);
		return {
			ok: true,
			document,
			...unsaved,
			instruction: { started: false, reason: code, ...(message ? { message } : {}) },
			next: `${retry}The document was created, but its Planner did not start. Tell the person, `
				+ "with its link, so they can ask it there.",
		};
	}
	return {
		ok: true,
		document,
		...unsaved,
		instruction: { started: true },
		next: `${retry}Its own Planner started on the instruction, as the requesting person's `
			+ "message, in that document's Chat. It runs on its own; this turn need not wait for it.",
	};
}
