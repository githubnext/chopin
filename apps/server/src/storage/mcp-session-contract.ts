import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage } from "./contract-support";

import type { StorageFactory } from "./contract-support";
import type { McpSession } from "./model";

const AT = new Date("2026-01-02T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

function session(overrides: Partial<McpSession> = {}): McpSession {
	return {
		id: id("mcp"),
		userId: id("user"),
		clientName: "coding-agent",
		clientVersion: "1.2.3",
		createdAt: AT,
		lastSeenAt: AT,
		...overrides,
	};
}

export function mcpSessionContract(name: string, factory: StorageFactory) {
	describe(`${name} MCP sessions`, () => {
		test("keeps a session across reads, and its first record when created again", async () => {
			let storage = await openedStorage(factory);
			try {
				let stored = session();
				expect(await storage.mcpSessions.find(stored.id)).toBeUndefined();
				await storage.mcpSessions.create(stored);
				expect(await storage.mcpSessions.find(stored.id)).toEqual(stored);
				await storage.mcpSessions.create({ ...stored, clientName: "other", lastSeenAt: later(9) });
				expect(await storage.mcpSessions.find(stored.id)).toEqual(stored);
			} finally {
				await storage.close();
			}
		});

		test("records activity forward only, and says when the session is unknown", async () => {
			let storage = await openedStorage(factory);
			try {
				let stored = session();
				await storage.mcpSessions.create(stored);
				expect(await storage.mcpSessions.touch(stored.id, later(10))).toBe(true);
				expect((await storage.mcpSessions.find(stored.id))!.lastSeenAt).toEqual(later(10));
				expect(await storage.mcpSessions.touch(stored.id, later(5))).toBe(true);
				expect((await storage.mcpSessions.find(stored.id))!.lastSeenAt).toEqual(later(10));
				expect(await storage.mcpSessions.touch(id("unknown"), later(10))).toBe(false);
			} finally {
				await storage.close();
			}
		});

		test("sweeps only sessions not seen since the cutoff", async () => {
			let storage = await openedStorage(factory);
			try {
				let idle = session({ lastSeenAt: later(-3_600) });
				let boundary = session({ lastSeenAt: later(-60) });
				let active = session({ lastSeenAt: later(-3_600) });
				for (let stored of [idle, boundary, active]) await storage.mcpSessions.create(stored);
				await storage.mcpSessions.touch(active.id, later(-10));
				let removed = await storage.mcpSessions.deleteIdle(later(-60));
				expect(removed).toBeGreaterThanOrEqual(1);
				expect(await storage.mcpSessions.find(idle.id)).toBeUndefined();
				expect(await storage.mcpSessions.find(boundary.id)).toBeDefined();
				expect(await storage.mcpSessions.find(active.id)).toBeDefined();
			} finally {
				await storage.close();
			}
		});
	});
}
