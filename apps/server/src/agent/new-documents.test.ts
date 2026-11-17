import { describe, expect, test } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { createDocument } from "../mcp/hosted";
import * as Plan from "../plan/service";
import {
	createNewDocument,
	MAX_DOCUMENTS_PER_HOUR,
	MAX_DOCUMENTS_PER_TURN,
	newDocumentArguments,
	NewDocumentLimits,
} from "./new-documents";

import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { PlannerInvocation } from "../mcp/hosted";
import type { InvokePlannerError } from "../mcp";
import type { NewDocumentArguments, NewDocumentDeps } from "./new-documents";
import type { CreationOrigin } from "../mcp/create";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

let brief = {
	goal: "Add the settings page.",
	constraints: [],
	settledDecisions: [],
	openQuestions: [],
	repositoryFindings: [],
};

function args(overrides: Partial<NewDocumentArguments> = {}): NewDocumentArguments {
	return {
		idempotencyKey: "settings-page",
		title: "Settings page",
		brief,
		document: "# Settings page\n\nA page for account settings.\n",
		...overrides,
	};
}

function login(userId = "U_mona"): AuthenticatedSession {
	return {
		session: { id: `session-${userId}`, userId },
		user: { id: userId, login: "mona", avatarUrl: "", createdAt: NOW, updatedAt: NOW },
	} as unknown as AuthenticatedSession;
}

function repository(permissions: Partial<Repository["permissions"]> = {}): Repository {
	return {
		id: "R_app",
		owner: "octo",
		name: "app",
		fullName: "octo/app",
		private: true,
		url: "https://github.test/octo/app",
		defaultBranch: "trunk",
		permissions: { pull: true, push: true, admin: false, ...permissions },
	};
}

async function fixture(options: {
	access?: Repository | undefined;
	session?: AuthenticatedSession | undefined;
	origin?: CreationOrigin;
	invoked?: InvokePlannerError;
	archived?: boolean;
	unsavedLines?: number;
} = {}) {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now: NOW });
	let source = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_app",
		repositoryOwner: "octo",
		repositoryName: "app",
		title: "Whole app",
		createdBy: "U_mona",
		now: NOW,
	});
	if (options.archived) await storage.channels.archive({ id: source.id, now: NOW });
	let events: string[] = [];
	let invocations: PlannerInvocation[] = [];
	let announced: Array<{ id: string; title: string; path: string }> = [];
	let created: string[] = [];
	let head = { commit: HEAD };
	let unsavedLines = options.unsavedLines ?? 0;
	let access = "access" in options ? options.access : repository();
	let session = "session" in options ? options.session : login();
	let deps: NewDocumentDeps = {
		channel: id => storage.channels.get(id),
		deleting: () => false,
		login: async () => session,
		repository: async () => access,
		branchHead: async (_login, _owner, _name, branch) => {
			events.push(`head:${branch}`);
			return head.commit;
		},
		origin: async () => options.origin,
		created: async channelId => {
			let stored = await storage.collaboration.load(channelId, NOW);
			return stored ? (await Plan.readStored(stored)).creation?.origin : undefined;
		},
		create: (creator, input, instructed) =>
			createDocument(
				{ storage, clock: () => NOW },
				{
					onChannelCreated: channel => {
						events.push(`sidebar:${instructed ? "in-use" : "listed"}`);
						created.push(channel.id);
					},
				},
				creator,
				input,
			),
		copyModel: async (from, to, userId) => {
			events.push(`model:${from === source.id}:${to !== source.id}:${userId}`);
		},
		invoke: async input => {
			events.push("invoke");
			invocations.push(input);
			return options.invoked;
		},
		refusal: async code => code === "planner-not-attached" ? "No machine runs it." : undefined,
		appOrigin: "https://chopin.test",
		limits: new NewDocumentLimits(() => NOW.getTime()),
	};
	let request = (value: NewDocumentArguments = args(), turnId = "turn-1") =>
		createNewDocument(deps, {
			sourceId: source.id,
			turnId,
			creator: { userId: "U_mona", handle: "mona", claimantSessionId: "session-U_mona" },
			arguments: value,
			announce: async document => {
				if (announced.some(value => value.id === document.id)) return;
				if (unsavedLines > 0) {
					unsavedLines--;
					throw new Error("storage is down");
				}
				events.push("announce");
				announced.push(document);
			},
		});
	return { storage, source, deps, events, invocations, announced, created, head, request };
}

describe("create_document arguments", () => {
	test("take only the documented fields", () => {
		expect(newDocumentArguments(args({ instruction: "Draft the API." }))).toEqual(
			args({ instruction: "Draft the API." }),
		);
		expect(() => newDocumentArguments({ ...args(), repository: "octo/other" })).toThrow(
			"does not take `repository`",
		);
		expect(() => newDocumentArguments(args({ idempotencyKey: "short" }))).toThrow(
			"idempotencyKey",
		);
		expect(() => newDocumentArguments(args({ instruction: " " }))).toThrow("instruction");
		expect(() => newDocumentArguments(args({ document: "" }))).toThrow("document");
	});
});

describe("new document limits", () => {
	test("bound one turn and one person's hour, and give back refunds", () => {
		let now = 0;
		let limits = new NewDocumentLimits(() => now);
		for (let index = 0; index < MAX_DOCUMENTS_PER_TURN; index++) {
			expect(limits.take("turn-a", "U_mona")).toBeUndefined();
		}
		expect(limits.take("turn-a", "U_mona")).toBe("turn");
		limits.refund("turn-a", "U_mona");
		expect(limits.take("turn-a", "U_mona")).toBeUndefined();
		let turn = 0;
		while (limits.take(`turn-${++turn}`, "U_mona") === undefined && turn < 100) {}
		expect(limits.take("turn-next", "U_mona")).toBe("hour");
		expect(limits.take("turn-next", "U_other")).toBeUndefined();
		now += 60 * 60_000;
		expect(limits.take("turn-next", "U_mona")).toBeUndefined();
		expect(MAX_DOCUMENTS_PER_HOUR).toBeGreaterThan(MAX_DOCUMENTS_PER_TURN);
	});
});

describe("createNewDocument", () => {
	test("stores a top-level document on the base branch before the Chat line and its Planner", async () => {
		let context = await fixture();
		let result = await context.request(args({ instruction: "Draft the API first." }));
		if (!result.ok) throw new Error(result.message);
		let channel = await context.storage.channels.get(result.document.id);
		expect(channel).toMatchObject({
			repositoryId: "R_app",
			createdBy: "U_mona",
			title: "Settings page",
		});
		expect(channel?.parentChannelId).toBeUndefined();
		expect(result.document.url).toBe(
			`https://chopin.test/documents/octo/app/${channel!.slug}`,
		);
		expect(result.instruction).toEqual({ started: true });
		expect(context.events).toEqual([
			"head:trunk",
			"sidebar:in-use",
			"announce",
			"model:true:true:U_mona",
			"invoke",
		]);
		expect(context.announced).toEqual([{
			id: channel!.id,
			title: "Settings page",
			path: `/documents/octo/app/${channel!.slug}`,
		}]);
		expect(context.invocations).toMatchObject([{
			channel: { id: channel!.id },
			repository: { id: "R_app", owner: "octo", name: "app" },
			user: { id: "U_mona", login: "mona" },
			instruction: "Draft the API first.",
		}]);
		expect(context.invocations[0]!.system).toBeUndefined();
		let stored = await context.storage.collaboration.load(channel!.id, NOW);
		expect(stored).toBeDefined();
	});

	test("keeps the creating document's recorded base", async () => {
		let context = await fixture({
			origin: {
				idempotencyKey: "earlier",
				fingerprint: "earlier",
				repository: "octo/app",
				baseBranch: "release",
				baseCommit: "fedcba9876543210fedcba9876543210fedcba98",
				title: "Whole app",
			},
		});
		let result = await context.request();
		expect(result.ok).toBe(true);
		expect(context.events).not.toContain("head:trunk");
		expect(context.events).toEqual(["sidebar:listed", "announce", "model:true:true:U_mona"]);
	});

	test("a retry with the same key creates and starts nothing again", async () => {
		let context = await fixture();
		let first = await context.request(args({ instruction: "Start." }));
		let second = await context.request(args({ instruction: "Start." }), "turn-2");
		if (!first.ok || !second.ok) throw new Error("expected both calls to succeed");
		expect(second.document).toEqual(first.document);
		expect(second.replayed).toBe(true);
		expect(context.created).toHaveLength(1);
		expect(context.announced).toHaveLength(1);
		expect(context.invocations).toHaveLength(1);
	});

	test("a retry after the default branch moved returns the first document", async () => {
		let context = await fixture();
		let first = await context.request();
		context.head.commit = "fedcba9876543210fedcba9876543210fedcba98";
		let second = await context.request();
		if (!first.ok || !second.ok) throw new Error("expected both calls to succeed");
		expect(second).toMatchObject({ replayed: true, document: first.document });
		expect(context.created).toHaveLength(1);
	});

	test("a retry is answered with its document after the turn's limit is spent", async () => {
		let context = await fixture();
		let pieces = Array.from({ length: MAX_DOCUMENTS_PER_TURN }, (_, index) =>
			args({
				idempotencyKey: `piece-number-${index}`,
				title: `Piece ${index}`,
				document: `# Piece ${index}\n`,
			}));
		let first = await context.request(pieces[0]);
		for (let piece of pieces.slice(1)) expect((await context.request(piece)).ok).toBe(true);
		let retried = await context.request(pieces[0]);
		if (!first.ok) throw new Error(first.message);
		expect(retried).toMatchObject({ ok: true, replayed: true, document: first.document });
		expect(context.created).toHaveLength(MAX_DOCUMENTS_PER_TURN);
	});

	test("a retry is answered with its document after the person's hour is spent", async () => {
		let context = await fixture();
		let first = await context.request(args(), "turn-0");
		for (let index = 1; index < MAX_DOCUMENTS_PER_HOUR; index++) {
			let result = await context.request(
				args({
					idempotencyKey: `piece-number-${index}`,
					title: `Piece ${index}`,
					document: `# Piece ${index}\n`,
				}),
				`turn-${index}`,
			);
			expect(result.ok).toBe(true);
		}
		let over = await context.request(
			args({ idempotencyKey: "piece-number-over", title: "Over", document: "# Over\n" }),
			"turn-over",
		);
		expect(over).toMatchObject({ ok: false, reason: "hour-limit" });
		let retried = await context.request(args(), "turn-over");
		if (!first.ok) throw new Error(first.message);
		expect(retried).toMatchObject({ ok: true, replayed: true, document: first.document });
	});

	test("a Chat line that could not be saved is posted by the retry, once", async () => {
		let context = await fixture({ unsavedLines: 1 });
		let first = await context.request(args({ instruction: "Start." }));
		if (!first.ok) throw new Error(first.message);
		expect(first.announced).toBe(false);
		expect(first.next).toContain("Call create_document again with the same arguments");
		expect(first.instruction).toEqual({ started: true });
		expect(context.announced).toEqual([]);
		let second = await context.request(args({ instruction: "Start." }));
		expect(second).toMatchObject({ ok: true, replayed: true, document: first.document });
		expect(second.ok && second.announced).toBeUndefined();
		let third = await context.request(args({ instruction: "Start." }));
		expect(third).toMatchObject({ ok: true, replayed: true });
		expect(context.announced).toHaveLength(1);
		expect(context.created).toHaveLength(1);
		expect(context.invocations).toHaveLength(1);
	});

	test("a different draft under the same key is a conflict", async () => {
		let context = await fixture();
		await context.request();
		let result = await context.request(args({ document: "# Settings page\n\nOther.\n" }));
		expect(result).toMatchObject({ ok: false, reason: "idempotency-conflict" });
	});

	test("is refused without the creator's own write access or login", async () => {
		for (
			let [options, reason] of [
				[{ access: repository({ push: false }) }, "repository-forbidden"],
				[{ access: undefined }, "repository-forbidden"],
				[{ access: { ...repository(), id: "R_other" } }, "repository-forbidden"],
				[{ session: undefined }, "sign-in-required"],
				[{ session: login("U_other") }, "sign-in-required"],
				[{ archived: true }, "document-unavailable"],
			] as const
		) {
			let context = await fixture(options);
			let result = await context.request();
			expect(result).toMatchObject({ ok: false, reason });
			expect(context.created).toEqual([]);
			expect(context.announced).toEqual([]);
		}
	});

	test("an invalid draft is refused with its issues before anything is stored", async () => {
		let context = await fixture();
		let result = await context.request(args({ document: "# Title\n\n<Script />\n" }));
		expect(result).toMatchObject({ ok: false, reason: "invalid-document" });
		expect(result.ok ? [] : result.issues?.length).toBeGreaterThan(0);
		expect(context.created).toEqual([]);
	});

	test("one turn creates at most its limit", async () => {
		let context = await fixture();
		for (let index = 0; index < MAX_DOCUMENTS_PER_TURN; index++) {
			let result = await context.request(args({
				idempotencyKey: `piece-number-${index}`,
				title: `Piece ${index}`,
				document: `# Piece ${index}\n`,
			}));
			expect(result.ok).toBe(true);
		}
		let over = await context.request(args({
			idempotencyKey: "piece-number-over",
			title: "Piece over",
			document: "# Piece over\n",
		}));
		expect(over).toMatchObject({ ok: false, reason: "turn-limit" });
		expect(context.created).toHaveLength(MAX_DOCUMENTS_PER_TURN);
	});

	test("says when the new document's Planner could not start", async () => {
		let context = await fixture({ invoked: "planner-not-attached" });
		let result = await context.request(args({ instruction: "Start." }));
		expect(result).toMatchObject({
			ok: true,
			instruction: {
				started: false,
				reason: "planner-not-attached",
				message: "No machine runs it.",
			},
		});
	});
});
