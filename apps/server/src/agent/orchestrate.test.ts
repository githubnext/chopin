import { describe, expect, test } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { createDocument } from "../mcp/hosted";
import { openPlan } from "../testing/plan";
import * as edit from "../plan/edit";
import { buildState, MAX_OPEN, orchestrate, orchestrateArguments } from "./orchestrate";
import { INDEX_HEADING, writeIndex } from "./orchestrate-index";
import { documentRoom } from "./heading-harness.test-fixtures";

import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { PlannerInvocation } from "../mcp/hosted";
import type { InvokePlannerError } from "../mcp";
import type { NewDocumentArguments } from "./new-documents";
import type {
	BuildState,
	CreatedDocumentState,
	IndexWriter,
	OrchestrateArguments,
	OrchestrateDeps,
	PlannerState,
} from "./orchestrate";
import type { BuildRequest } from "@chopin/protocol/implementation";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

let brief = {
	goal: "Verify one part of the app.",
	constraints: [],
	settledDecisions: [],
	openQuestions: [],
	repositoryFindings: [],
};

function piece(key: string, title: string, instruction?: string): NewDocumentArguments {
	return {
		idempotencyKey: key,
		title,
		brief,
		document: `# ${title}\n\nOne part of the app.\n`,
		...(instruction ? { instruction } : {}),
	};
}

function login(): AuthenticatedSession {
	return {
		session: { id: "session-U_mona", userId: "U_mona" },
		user: { id: "U_mona", login: "mona", avatarUrl: "", createdAt: NOW, updatedAt: NOW },
	} as unknown as AuthenticatedSession;
}

function repository(push = true): Repository {
	return {
		id: "R_app",
		owner: "octo",
		name: "app",
		fullName: "octo/app",
		private: true,
		url: "https://github.test/octo/app",
		defaultBranch: "trunk",
		permissions: { pull: true, push, admin: false },
	};
}

async function fixture(
	options: { push?: boolean; refuse?: Record<string, InvokePlannerError> } = {},
) {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now: NOW });
	let fields = {
		repositoryId: "R_app",
		repositoryOwner: "octo",
		repositoryName: "app",
		createdBy: "U_mona",
		now: NOW,
	};
	let source = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Whole app",
	});
	let invocations: PlannerInvocation[] = [];
	let planners = new Map<string, PlannerState>();
	let builds = new Map<string, BuildState>();
	let push = options.push ?? true;
	let deps: OrchestrateDeps = {
		channel: id => storage.channels.get(id),
		deleting: () => false,
		login: async () => login(),
		repository: async () => repository(push),
		branchHead: async () => HEAD,
		origin: async () => undefined,
		created: async () => undefined,
		create: (creator, input) => createDocument({ storage, clock: () => NOW }, {}, creator, input),
		modelChoice: async () => undefined,
		invoke: async input => {
			invocations.push(input);
			return options.refuse?.[input.channel.title];
		},
		refusal: async code => code === "planner-busy" ? "It is answering someone now." : undefined,
		appOrigin: "https://chopin.test",
		createdFrom: (sourceId, limit) => storage.channels.createdFrom(sourceId, limit),
		planner: id => planners.get(id) ?? "stopped",
		build: async id => builds.get(id) ?? "not built",
	};
	let indexed: Array<{ documents: CreatedDocumentState[]; create: boolean }> = [];
	let index: IndexWriter = async (documents, create) => {
		indexed.push({ documents, create });
		return create ? { state: "written" } : { state: "absent" };
	};
	let call = (args: OrchestrateArguments) =>
		orchestrate(deps, {
			sourceId: source.id,
			creator: { userId: "U_mona", handle: "mona" },
			arguments: args,
			announce: async () => {},
			index,
		});
	let open = async (...documents: NewDocumentArguments[]) => {
		let result = await call({ operation: "open", documents });
		if (!result.ok || result.operation !== "open") throw new Error("open failed");
		return result.documents.map(document => {
			if (!document.ok) throw new Error(document.message);
			return document.document;
		});
	};
	return { storage, source, fields, deps, invocations, planners, builds, indexed, call, open };
}

/** Documents created at the same moment are listed in no promised order. */
function byTitle<T extends { title: string }>(documents: T[]): T[] {
	return documents.toSorted((left, right) => left.title.localeCompare(right.title));
}

describe("orchestrate arguments", () => {
	test("take each operation's own fields only", () => {
		expect(orchestrateArguments({ operation: "list" })).toEqual({ operation: "list" });
		expect(orchestrateArguments({ operation: "instruct", instruction: "Resume." })).toEqual({
			operation: "instruct",
			instruction: "Resume.",
		});
		expect(() => orchestrateArguments({ operation: "list", instruction: "Resume." })).toThrow(
			"orchestrate list does not take `instruction`",
		);
		expect(() => orchestrateArguments({ operation: "close" })).toThrow("operation must be one of");
		expect(() => orchestrateArguments({ operation: "instruct" })).toThrow("instruction");
		expect(() => orchestrateArguments({ operation: "instruct", instruction: "Go.", targets: [] }))
			.toThrow("targets");
	});

	test("open checks every document as create_document does, and needs distinct keys", () => {
		expect(() => orchestrateArguments({ operation: "open", documents: [] })).toThrow(
			"at least one",
		);
		expect(() =>
			orchestrateArguments({
				operation: "open",
				documents: [piece("login-page", "Login"), { title: "x" }],
			})
		).toThrow("documents[1]: idempotencyKey");
		expect(() =>
			orchestrateArguments({
				operation: "open",
				documents: [piece("login-page", "Login"), piece("login-page", "Login again")],
			})
		).toThrow("its own idempotencyKey");
		let many = Array.from({ length: MAX_OPEN + 1 }, (_, n) => piece(`document-${n}`, `D${n}`));
		expect(() => orchestrateArguments({ operation: "open", documents: many })).toThrow("at most");
	});
});

describe("orchestrate", () => {
	test("open creates each document linked to this one, and a retry makes none twice", async () => {
		let context = await fixture();
		let opened = await context.open(
			piece("login-page", "Login", "Plan the login page."),
			piece("checkout-flow", "Checkout"),
		);
		expect(opened.map(document => document.title)).toEqual(["Login", "Checkout"]);
		for (let document of opened) {
			expect((await context.storage.channels.get(document.id))?.createdFrom).toBe(
				context.source.id,
			);
		}
		expect(context.invocations.map(invocation => invocation.instruction)).toEqual([
			"Plan the login page.",
		]);
		let again = await context.call({
			operation: "open",
			documents: [piece("login-page", "Login")],
		});
		expect(again).toMatchObject({ ok: true, documents: [{ replayed: true, document: opened[0] }] });
		expect(await context.storage.channels.createdFrom(context.source.id, 10)).toHaveLength(2);
		expect(context.indexed.map(item => item.create)).toEqual([false, false]);
	});

	test("list reports what this document created, with each Planner, open Decisions and build", async () => {
		let context = await fixture();
		let [login, checkout] = await context.open(
			piece("login-page", "Login"),
			piece("checkout-flow", "Checkout"),
		);
		await context.storage.channels.create({
			...context.fields,
			id: crypto.randomUUID(),
			title: "Made by a person",
		});
		context.planners.set(login!.id, "working");
		context.builds.set(checkout!.id, "built");
		let listed = await context.call({ operation: "list" });
		if (!listed.ok || listed.operation !== "list") throw new Error("list failed");
		expect(byTitle(listed.documents)).toEqual([
			{
				id: checkout!.id,
				title: "Checkout",
				url: checkout!.url,
				planner: "stopped",
				openDecisions: 0,
				build: "built",
			},
			{
				id: login!.id,
				title: "Login",
				url: login!.url,
				planner: "working",
				openDecisions: 0,
				build: "not built",
			},
		]);
		expect(listed).not.toHaveProperty("index");
		expect(context.indexed).toHaveLength(2);
		expect(context.indexed.at(-1)).toMatchObject({ create: false });
	});

	test("instruct hands every created Planner the instruction as the person's message", async () => {
		let context = await fixture({ refuse: { Checkout: "planner-busy" } });
		let [login, checkout] = await context.open(
			piece("login-page", "Login"),
			piece("checkout-flow", "Checkout"),
		);
		let result = await context.call({ operation: "instruct", instruction: "Resume your plan." });
		if (!result.ok || result.operation !== "instruct") throw new Error("instruct failed");
		expect(byTitle(result.documents)).toMatchObject([
			{
				id: checkout!.id,
				started: false,
				reason: "planner-busy",
				message: "It is answering someone now.",
			},
			{ id: login!.id, started: true },
		]);
		let invoked = context.invocations.toSorted((left, right) =>
			left.channel.title.localeCompare(right.channel.title)
		);
		expect(invoked).toMatchObject([
			{ channel: { id: checkout!.id }, instruction: "Resume your plan." },
			{ channel: { id: login!.id }, instruction: "Resume your plan.", user: { id: "U_mona" } },
		]);
		expect(invoked.every(invocation => invocation.system === undefined)).toBe(true);
	});

	test("instruct reaches only the named documents this one created, and names any it did not", async () => {
		let context = await fixture();
		let [login] = await context.open(
			piece("login-page", "Login"),
			piece("checkout-flow", "Checkout"),
		);
		let stranger = await context.storage.channels.create({
			...context.fields,
			id: crypto.randomUUID(),
			title: "Made by a person",
		});
		let result = await context.call({
			operation: "instruct",
			instruction: "Resume.",
			targets: [login!.url, stranger.id],
		});
		expect(result).toMatchObject({
			ok: true,
			documents: [{ id: login!.id, started: true }],
			unknown: [stranger.id],
		});
		expect(context.invocations.map(invocation => invocation.channel.id)).toEqual([login!.id]);
	});

	test("instruct is refused for a person who can't write the repository", async () => {
		let context = await fixture({ push: false });
		await context.storage.channels.create({
			...context.fields,
			id: crypto.randomUUID(),
			title: "Login",
			createdFrom: context.source.id,
		});
		let result = await context.call({ operation: "instruct", instruction: "Resume." });
		expect(result).toMatchObject({ ok: false, reason: "repository-forbidden" });
		expect(context.invocations).toEqual([]);
	});

	test("instruct with nothing created says so", async () => {
		let context = await fixture();
		expect(await context.call({ operation: "instruct", instruction: "Resume." })).toMatchObject({
			ok: false,
			reason: "nothing-created",
		});
	});

	test("index writes the table even before it exists", async () => {
		let context = await fixture();
		await context.open(piece("login-page", "Login"));
		let result = await context.call({ operation: "index" });
		expect(result).toMatchObject({ ok: true, operation: "index", index: { state: "written" } });
		expect(context.indexed.at(-1)).toMatchObject({ create: true, documents: [{ title: "Login" }] });
	});
});

describe("buildState", () => {
	let build = (state: BuildRequest["state"], createdAt: string) =>
		({ state, createdAt }) as BuildRequest;

	test("a running build, a delivered one, then how the last one ended", () => {
		expect(buildState({ builds: [] })).toBe("not built");
		expect(buildState({ builds: [build("failed", "1"), build("running", "2")] })).toBe("building");
		expect(buildState({ builds: [build("failed", "1")], live: { buildId: "b" } })).toBe("built");
		expect(buildState({ builds: [build("stopped", "2"), build("failed", "1")] })).toBe("stopped");
	});
});

function documents(planner: PlannerState): CreatedDocumentState[] {
	return [{
		id: "D1",
		title: "Login | sign in",
		url: "https://chopin.test/documents/octo/app/login",
		planner,
		openDecisions: 2,
		build: "not built",
	}];
}

describe("writeIndex", () => {
	test("adds its section once, refreshes only its own table, and leaves the rest alone", async () => {
		let context = await openPlan("# Whole app\n\nWhat the app does.\n");
		let room = documentRoom(context);
		expect(await writeIndex(room, documents("idle"), false)).toEqual({ state: "absent" });
		expect(edit.source(context.plan)).not.toContain(INDEX_HEADING);

		expect(await writeIndex(room, documents("idle"), true)).toEqual({ state: "written" });
		let written = edit.source(context.plan);
		expect(written).toContain("What the app does.");
		expect(written).toContain(`## ${INDEX_HEADING}`);
		expect(written).toContain("[Login \\| sign in](https://chopin.test/documents/octo/app/login)");
		expect(written).toContain("| idle");
		let revision = context.plan.revision;

		expect(await writeIndex(room, documents("idle"), false)).toEqual({ state: "unchanged" });
		expect(context.plan.revision).toBe(revision);

		expect(await writeIndex(room, documents("working"), false)).toEqual({ state: "written" });
		let refreshed = edit.source(context.plan);
		expect(refreshed).toContain("| working");
		expect(refreshed).not.toContain("| idle");
		expect(refreshed.split(INDEX_HEADING)).toHaveLength(2);
		expect(refreshed).toContain("What the app does.");
	});

	test("says when nothing has been created yet", async () => {
		let context = await openPlan("# Whole app\n\nWhat the app does.\n");
		let room = documentRoom(context);
		expect(await writeIndex(room, [], true)).toEqual({ state: "written" });
		expect(edit.source(context.plan)).toContain("No document has been created from this one yet.");
		expect(await writeIndex(room, documents("idle"), false)).toEqual({ state: "written" });
		expect(edit.source(context.plan)).not.toContain("No document has been created");
	});
});
