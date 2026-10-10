import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import * as Plan from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { openPlan } from "../testing/plan";
import { draftInstruction, draftRefusal } from "../tasks/draft";
import { implementationGraphs } from "../tasks/plan-graphs";
import * as Chat from "./service";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { Config } from "../config";
import type { GitHub } from "../github/client";
import type { SocketData } from "../wire";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	let now = new Date();
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_ana", login: "ana", avatarUrl: "", now });
	let sessions = new Sessions(storage, false);
	let login = await sessions.issue("U_ana", {
		accessToken: "browser-token",
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 86_400,
	});
	let repository = { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" };
	let github = {
		repositoryAccess: async () => ({
			...repository,
			permissions: { push: true, pull: true, admin: false },
		}),
	} as unknown as GitHub;
	let authConfig = {
		origin: "http://localhost:8795",
		appSlug: "test",
		clientId: "test",
		encryptionKey: new Uint8Array(32),
	};
	let auth: HostedAuth = {
		config: authConfig,
		github,
		storage,
		sessions,
		clock: () => new Date(),
		admission: new Admission(authConfig, github),
	};
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: "Document",
		createdBy: "U_ana",
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let events: Array<{ kind: string; [key: string]: unknown }> = [];
	let server = {
		publish(_topic: string, message: string) {
			events.push(JSON.parse(message));
		},
	} as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, server);
	let owners = new ActiveOwnerBindings(auth);
	let saved = 0;
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		room: channel.id,
		server,
		auth,
		repository,
		config: { agent: true } as Config,
		claimantSessionId: login.id,
		activeOwner: () => owners.resolve(channel.id),
		persist: async () => {
			saved++;
			await Plan.persist(plan);
		},
	};
	// Each turn waits for its own release, so a test can hold one open.
	let prompts: string[] = [];
	let releases: Array<() => void> = [];
	let opened: Array<() => void> = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream(prompt) {
				prompts.push(prompt);
				let release = Promise.withResolvers<void>();
				releases.push(release.resolve);
				opened.splice(0).forEach(resolve => resolve());
				return {
					fullStream: (async function*() {
						await release.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	let turnOpened = () => {
		let waiting = Promise.withResolvers<void>();
		opened.push(waiting.resolve);
		return waiting.promise;
	};
	cleanups.push(async () => {
		releases.forEach(release => release());
		owners.revokeAll();
		await Plan.close(plan);
	});
	return { context, events, prompts, releases, turnOpened, saves: () => saved, plan };
}

function drafting(events: Array<{ kind: string; [key: string]: unknown }>) {
	return events.filter(event => event.kind === "implementation:drafting")
		.map(event => event.state);
}

test("a task draft runs a Planner turn with no member message and says who asked", async () => {
	let { context, events, prompts, releases, turnOpened } = await setup();
	let started = turnOpened();
	let result = await Chat.draftTasks(context, "ana", 3, "Prepare the tasks.", "@ana asked.");
	expect(result).toMatchObject({
		ok: true,
		existing: false,
		state: "running",
		draft: { planRevision: 3 },
	});
	await started;
	expect(prompts).toEqual(["@ana: Prepare the tasks."]);
	expect(context.chat.entries.map(entry => [entry.author.kind, entry.text])).toEqual([
		["system", "@ana asked."],
	]);
	expect(drafting(events)).toEqual(["running"]);

	// A collaborator joins the live request, even having seen a later revision.
	let again = await Chat.draftTasks(context, "ben", 4, "Prepare the tasks.", "@ben asked.");
	expect(again).toMatchObject({ ok: true, existing: true });
	expect(again.ok && result.ok && again.draft.id).toBe(result.ok && result.draft.id);
	expect(context.chat.entries).toHaveLength(1);

	releases[0]!();
	await context.chat.running;
	expect(drafting(events)).toEqual(["running", "ended"]);
	expect(prompts).toHaveLength(1);
	// Ended, so the same revision may be asked for again.
	let retry = await Chat.draftTasks(context, "ana", 3, "Prepare the tasks.", "@ana asked.");
	expect(retry).toMatchObject({ ok: true, existing: false });
});

test("a task draft queued behind another turn stays out of the visible queue", async () => {
	let { context, events, prompts, releases, turnOpened } = await setup();
	let first = turnOpened();
	await Chat.instruct(context, "ana", "Apply the comment.", "Comment accepted.");
	await first;
	let result = await Chat.draftTasks(context, "ana", 4, "Revise the tasks.", "@ana asked.");
	expect(result).toMatchObject({ ok: true, state: "queued" });
	expect(drafting(events)).toEqual(["queued"]);
	let queue = events.findLast(event => event.kind === "chat:queue");
	expect(queue?.waiting ?? []).toEqual([]);
	expect(await Chat.draftTasks(context, "ben", 4, "Revise the tasks.", "@ben asked."))
		.toMatchObject({ ok: true, existing: true });

	let second = turnOpened();
	releases[0]!();
	await second;
	expect(prompts.at(-1)).toBe("@ana: Revise the tasks.");
	expect(drafting(events)).toEqual(["queued", "running"]);
	releases[1]!();
	await context.chat.running;
	expect(drafting(events)).toEqual(["queued", "running", "ended"]);
	expect(context.chat.busy).toBe(false);
});

test("a task draft is refused without a Planner or when the notice cannot be saved", async () => {
	let { context, prompts } = await setup();
	context.config.agent = false;
	expect(await Chat.draftTasks(context, "ana", 1, "Prepare.", "@ana asked.")).toEqual({
		ok: false,
		reason: "the Planner is not running",
	});
	context.config.agent = true;
	context.persist = async () => {
		throw new Error("disk full");
	};
	expect(await Chat.draftTasks(context, "ana", 1, "Prepare.", "@ana asked.")).toMatchObject({
		ok: false,
	});
	expect(context.chat.draft).toBeUndefined();
	expect(context.chat.waiting).toEqual([]);
	expect(prompts).toEqual([]);
});

test("a task draft takes the same limits as a Chat message, even with the Planner idle", async () => {
	let { context, prompts } = await setup();
	context.chat.pendingSends = 20;
	expect(await Chat.draftTasks(context, "ana", 1, "Prepare.", "@ana asked.")).toEqual({
		ok: false,
		reason: "the Planner queue is full",
	});
	context.chat.pendingSends = 0;
	context.chat.waiting = Array.from({ length: 20 }, (_, index) => ({
		id: `held-${index}`,
		handle: "ana",
		text: "Held.",
	}));
	expect(context.chat.busy).toBe(false);
	expect(await Chat.draftTasks(context, "ana", 1, "Prepare.", "@ana asked.")).toEqual({
		ok: false,
		reason: "the Planner queue is full",
	});
	expect(context.chat.draft).toBeUndefined();
	expect(context.chat.entries).toEqual([]);
	expect(prompts).toEqual([]);
});

test("a draft whose turn finishes before its answer is answered as ended", async () => {
	let { context, events, releases, turnOpened } = await setup();
	let first = turnOpened();
	await Chat.instruct(context, "ana", "Apply the comment.", "Comment accepted.");
	await first;
	// Hold the draft's notice save while the turn ahead of it ends and the draft runs.
	let persist = context.persist;
	let held = Promise.withResolvers<void>();
	let holding = true;
	context.persist = async () => {
		if (holding) {
			holding = false;
			await held.promise;
		}
		await persist();
	};
	let asked = Chat.draftTasks(context, "ana", 2, "Prepare.", "@ana asked.");
	await new Promise(resolve => setTimeout(resolve, 10));
	let second = turnOpened();
	releases[0]!();
	await second;
	releases[1]!();
	await context.chat.running;
	expect(drafting(events)).toEqual(["running", "ended"]);
	held.resolve();
	expect(await asked).toMatchObject({ ok: true, existing: false, state: "ended" });
	expect(context.chat.draft).toBeUndefined();
});

test("the draft instruction comes from the plan and refuses an unsettled one", async () => {
	let { plan } = await openPlan("# Settled\n\nReady to build.\n");
	let prepare = draftInstruction(plan, "ana");
	expect(prepare.text).toContain("Prepare an implementation graph");
	expect(prepare.text).toContain("Do not approve or start implementation.");
	expect(prepare.said).toBe("@ana asked Chopin to break the plan into tasks.");
	expect(draftRefusal(plan)).toBeUndefined();
	let revised = await implementationGraphs().revise(plan, {
		planRevision: plan.revision,
		graphRevision: 0,
		operations: [{
			op: "add",
			task: {
				id: "first",
				title: "First",
				context: "Tracer",
				goal: "Go",
				acceptance: ["Starts", "Reports"],
				dependsOn: [],
			},
		}],
	});
	expect(revised).toMatchObject({ ok: true });
	expect(plan.graph).toBeDefined();
	let revise = draftInstruction(plan, "ana");
	expect(revise.text).toContain("Revise the implementation graph");
	expect(revise.said).toBe("@ana asked Chopin to update the tasks.");
	plan.builds = [{ state: "running" } as never];
	expect(draftRefusal(plan)).toBe("implementation is already active");
});
