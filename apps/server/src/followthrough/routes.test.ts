import { describe, expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import type { Investigation } from "@chopin/experiment/records";
import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, Repository } from "../github/client";
import { Router } from "../http/router";
import type { Followthrough } from "../storage/followthrough";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerFollowthroughRoutes } from "./routes";

async function setup() {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "alice", login: "alice", avatarUrl: "", now });
	let sessions = new Sessions(storage, true);
	let issued = await sessions.issue("alice", {
		accessToken: "github-user",
		accessExpiresIn: 3600,
		refreshToken: "github-refresh",
		refreshExpiresIn: 7200,
	});
	let cookie = issued.cookie.split(";", 1)[0]!;
	let access = { id: "R_score", permissions: { pull: true, push: true, admin: false } };
	let checked: string[] = [];
	let github = {
		repositoryAccess: async (token: string, owner: string, name: string) => {
			checked.push(token);
			return { ...access, owner, name } as Repository;
		},
	} as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "test",
		clientId: "test",
		clientSecret: "secret",
		encryptionKey: new Uint8Array(32).fill(3),
	};
	let auth: HostedAuth = {
		storage,
		sessions,
		github,
		config,
		admission: new Admission(config, github),
		clock: () => new Date(),
		pairings: {},
		machines: new Machines(storage, () => new Date(), { origin: config.origin, clientId: "test" }),
	};
	let parent = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: access.id,
		repositoryOwner: "org",
		repositoryName: "score",
		title: "Startup",
		createdBy: "alice",
		now,
	});
	let lease = (await storage.leases.acquire("writer", "route-tests", 60_000))!;
	let investigation: Investigation = {
		id: crypto.randomUUID(),
		documentId: parent.id,
		brief: "Does caching help startup?",
		requester: "alice",
		revision: 0,
		state: "publishing",
		generation: 1,
		expiresAt: 0,
		createdAt: now.getTime(),
		updatedAt: now.getTime(),
		progress: "",
		views: {},
		decisions: [],
		receipts: {},
		candidate: performance,
	};
	await storage.experiments.save(investigation, undefined, lease);
	let completed = { ...investigation };
	delete completed.candidate;
	let published = await storage.experiments.publish(
		{
			...completed,
			state: "completed",
			revision: 1,
			result: performance,
		},
		0,
		{
			title: "Evidence",
			now,
			initial: {
				generation: crypto.randomUUID(),
				epoch: "test-epoch",
				source: "# Evidence\n",
				sourceHash: "evidence-hash",
				document: new Uint8Array([1]),
				sidecar: {},
			},
		},
		lease,
	);
	if (!published || !published.childId) {
		throw new Error("fixture did not publish its evidence child");
	}
	let childId = published.childId;
	let [receipt] = await storage.followthrough.forSource(
		parent.id,
		"investigation",
		investigation.id,
	);
	if (!receipt) throw new Error("fixture did not publish its receipt");
	let changed: Followthrough[] = [];
	let wakes: string[] = [];
	let router = new Router();
	registerFollowthroughRoutes(router, auth, {
		lease: () => lease,
		changed: value => changed.push(value),
		wake: id => wakes.push(id),
	});
	async function post(
		action: "retry" | "dismiss",
		body: unknown = { revision: 0 },
		channelId = parent.id,
		session = cookie,
		origin = config.origin,
	) {
		return (await router.handle(
			new Request(
				`${config.origin}/api/channels/${channelId}/followthrough/${receipt!.id}/${action}`,
				{
					method: "POST",
					headers: { origin, cookie: session, "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			),
		))!;
	}
	async function failed() {
		await storage.followthrough.claim(parent.id, receipt!.id, 0, {
			planRevision: 1,
			sourceHash: "parent-hash",
		}, lease);
		return (await storage.followthrough.finish(
			parent.id,
			receipt!.id,
			1,
			"failed",
			"review-failed",
			lease,
		))!;
	}
	return { storage, parent, childId, receipt, access, checked, changed, wakes, post, failed, now };
}

describe("follow-through review routes", () => {
	for (let action of ["retry", "dismiss"] as const) {
		test(`${action} requires same-origin authentication and repository write access`, async () => {
			let fixture = await setup();
			let { post, access, storage, parent, receipt, changed, wakes } = fixture;
			expect((await post(action, { revision: 0 }, parent.id, "")).status).toBe(401);
			expect(
				(await post(action, { revision: 0 }, parent.id, undefined, "https://foreign.test")).status,
			).toBe(403);
			access.permissions.push = false;
			expect((await post(action)).status).toBe(403);
			expect(await storage.followthrough.get(parent.id, receipt.id)).toEqual(receipt);
			expect(changed).toEqual([]);
			expect(wakes).toEqual([]);
		});
	}

	test("hides wrong repository identity and parent scope without changing the receipt", async () => {
		let { post, access, storage, parent, childId, receipt, now, checked, changed, wakes } =
			await setup();
		access.id = "R_replaced";
		expect((await post("dismiss")).status).toBe(404);
		access.id = parent.repositoryId;
		access.permissions.pull = false;
		expect((await post("dismiss")).status).toBe(404);
		access.permissions.pull = true;
		let other = await storage.channels.create({
			...parent,
			id: crypto.randomUUID(),
			title: "Other parent",
			now,
		});
		expect((await post("dismiss", { revision: 0 }, other.id)).status).toBe(404);
		let checksBeforeChildRequest = checked.length;
		expect((await post("dismiss", { revision: 0 }, childId)).status).toBe(404);
		expect(checked).toHaveLength(checksBeforeChildRequest);
		expect(await storage.followthrough.get(parent.id, receipt.id)).toEqual(receipt);
		expect(changed).toEqual([]);
		expect(wakes).toEqual([]);
	});

	test("rejects malformed revisions before mutation", async () => {
		let { post, storage, parent, receipt, changed, wakes } = await setup();
		for (
			let body of [
				{},
				[],
				{ revision: "0" },
				{ revision: -1 },
				{ revision: 0.5 },
				{ revision: Number.MAX_SAFE_INTEGER + 1 },
				{ revision: 0, extra: true },
				{ revision: 0, padding: "x".repeat(300) },
			]
		) {
			let response = await post("dismiss", body);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "review revision is required" });
		}
		expect(await storage.followthrough.get(parent.id, receipt.id)).toEqual(receipt);
		expect(changed).toEqual([]);
		expect(wakes).toEqual([]);
	});

	test("retries failed work once and rejects a stale concurrent revision", async () => {
		let { post, failed, storage, parent, receipt, changed, wakes } = await setup();
		let failure = await failed();
		let responses = await Promise.all([
			post("retry", { revision: failure.revision }),
			post("retry", { revision: failure.revision }),
		]);
		expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
		let success = responses.find(response => response.status === 200)!;
		expect(await success.json()).toEqual({ id: receipt.id, revision: 3, status: "pending" });
		expect(success.headers.get("cache-control")).toBe("no-store");
		expect(success.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await storage.followthrough.get(parent.id, receipt.id)).toMatchObject({
			status: "pending",
			revision: 3,
			attempts: 1,
		});
		expect(changed).toHaveLength(1);
		expect(wakes).toEqual([parent.id]);
	});

	test("dismisses pending work without scheduling a turn", async () => {
		let { post, storage, parent, receipt, changed, wakes } = await setup();
		let response = await post("dismiss");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: receipt.id,
			revision: 1,
			status: "skipped",
			reason: "dismissed",
		});
		expect(await storage.followthrough.get(parent.id, receipt.id)).toMatchObject({
			status: "skipped",
			revision: 1,
			attempts: 0,
		});
		expect(changed).toHaveLength(1);
		expect(wakes).toEqual([]);
		expect((await post("dismiss", { revision: 0 })).status).toBe(409);
		expect(changed).toHaveLength(1);
	});

	test("cannot retry when the evidence child is unavailable", async () => {
		let { post, failed, storage, parent, childId, receipt, changed, wakes } = await setup();
		let failure = await failed();
		await storage.channels.archive({ id: childId, now: new Date() });
		let response = await post("retry", { revision: failure.revision });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "the result is no longer available in this document",
		});
		expect(await storage.followthrough.get(parent.id, receipt.id)).toEqual(failure);
		expect(changed).toEqual([]);
		expect(wakes).toEqual([]);
	});
});
