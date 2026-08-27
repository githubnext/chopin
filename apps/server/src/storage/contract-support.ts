import type { EnqueueBackgroundJob, Lease } from "./model";
import type { StorageAdapter } from "./port";

export type StorageFactory = () => StorageAdapter | Promise<StorageAdapter>;

export function contractId(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

export async function openedStorage(factory: StorageFactory): Promise<StorageAdapter> {
	let storage = await factory();
	await storage.migrate();
	return storage;
}

export async function userAndChannel(storage: StorageAdapter): Promise<{
	userId: string;
	sessionId: string;
	channelId: string;
	repositoryId: string;
	lease: Lease;
}> {
	let now = new Date("2026-01-02T03:04:05.000Z");
	let userId = contractId("user");
	let sessionId = contractId("session");
	let channelId = contractId("channel");
	let repositoryId = contractId("repository");
	await storage.users.put({
		id: userId,
		login: "octocat",
		avatarUrl: "https://example.test/a",
		now,
	});
	await storage.sessions.create({
		id: sessionId,
		userId,
		expiresAt: new Date("2026-02-02T03:04:05.000Z"),
		createdAt: now,
	});
	await storage.channels.create({
		id: channelId,
		repositoryId,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: userId,
		now,
	});
	let lease = await storage.leases.acquire(
		contractId("channel-writer"),
		contractId("instance"),
		60_000,
	);
	if (!lease) throw new Error("test could not acquire its storage lease");
	return { userId, sessionId, channelId, repositoryId, lease };
}

export function backgroundJob(
	channelId: string,
	lease: Lease,
	overrides: Partial<EnqueueBackgroundJob> = {},
): EnqueueBackgroundJob {
	let now = overrides.now ?? new Date();
	return {
		id: contractId("job"),
		channelId,
		type: "document-summary",
		version: 1,
		origin: "scheduler",
		targetKey: "document-summary",
		idempotencyKey: contractId("enqueue"),
		fingerprint: contractId("fingerprint"),
		input: { revision: 1 },
		availableAt: now,
		now,
		lease,
		...overrides,
	};
}
