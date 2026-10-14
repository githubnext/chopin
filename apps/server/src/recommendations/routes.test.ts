import { expect, test } from "bun:test";
import { Router } from "../http/router";
import { registerRecommendationRoutes } from "./routes";

import type { HostedAuth } from "../auth/routes";

function fixture() {
	let authenticated = true;
	let repositoryId = "R_test";
	let pull = true;
	let channel = {
		id: "document",
		repositoryId: "R_test",
		repositoryOwner: "octo",
		repositoryName: "score",
		archivedAt: undefined as Date | undefined,
		parentChannelId: undefined as string | undefined,
	};
	let reads = 0;
	let scheduled = 0;
	let accesses = 0;
	let auth = {
		sessions: {
			authenticate: async () => authenticated ? { user: { id: "reader" } } : undefined,
			use: async (_session: unknown, action: (token: string) => Promise<unknown>) => ({
				value: await action("token"),
			}),
		},
		storage: { channels: { get: async (id: string) => id === channel.id ? channel : undefined } },
		github: {
			repositoryAccess: async () => {
				accesses++;
				return { id: repositoryId, permissions: { pull, push: false } };
			},
		},
	} as unknown as HostedAuth;
	let router = new Router();
	registerRecommendationRoutes(router, auth, {
		read: async () => {
			reads++;
			return { state: "pending", key: "context" };
		},
		schedule: () => {
			scheduled++;
		},
	});
	return {
		channel,
		call: (id = "document") =>
			router.handle(new Request(`https://chopin.test/api/channels/${id}/recommendation`)),
		counts: () => ({ reads, scheduled, accesses }),
		anonymous: () => {
			authenticated = false;
		},
		deny: () => {
			pull = false;
		},
		mismatch: () => {
			repositoryId = "R_other";
		},
	};
}

test("repository readers see advisory state without write access", async () => {
	let value = fixture();
	let response = await value.call();
	expect(response?.status).toBe(200);
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(await response?.json()).toEqual({ state: "pending", key: "context" });
	expect(value.counts()).toEqual({ reads: 1, scheduled: 1, accesses: 1 });
});

test("missing identity, repository access, and node identity never expose advice or schedule work", async () => {
	for (let mode of ["anonymous", "deny", "mismatch"] as const) {
		let value = fixture();
		value[mode]();
		expect((await value.call())?.status).toBe(mode === "anonymous" ? 401 : 404);
		expect(value.counts().reads).toBe(0);
		expect(value.counts().scheduled).toBe(0);
	}
});

test("children and archived documents do not start assessments", async () => {
	let child = fixture();
	child.channel.parentChannelId = "parent";
	expect((await child.call())?.status).toBe(404);
	expect(child.counts().scheduled).toBe(0);
	let archived = fixture();
	archived.channel.archivedAt = new Date();
	expect(await (await archived.call())?.json()).toEqual({ state: "unavailable" });
	expect(archived.counts().reads).toBe(0);
	expect(archived.counts().scheduled).toBe(0);
});
