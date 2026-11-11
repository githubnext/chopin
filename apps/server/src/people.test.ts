import { describe, expect, it } from "bun:test";

import { builders, introduce, named, pictures } from "./people";
import { MemoryStorage } from "./storage/memory/adapter";

import type { Server } from "bun";
import type { SocketData } from "./wire";

const now = new Date("2026-10-14T10:00:00.000Z");

describe("the people a document names", () => {
	it("are everyone its Chat, comments and decisions credit, once each, and never a demo actor", () => {
		let logins = named({
			chat: {
				entries: [
					{ id: "1", author: { kind: "member", handle: "ana_acme" }, text: "hi", ts: 1 },
					{ id: "2", author: { kind: "agent" }, text: "hello", ts: 2 },
					{ id: "3", author: { kind: "system" }, text: "notice", ts: 3 },
					{ id: "4", author: { kind: "member", handle: "ANA_ACME" }, text: "again", ts: 4 },
					{ id: "5", author: { kind: "member", handle: "demo:lily" }, text: "persona", ts: 5 },
				],
				waiting: [{ id: "6", handle: "bo_acme", text: "queued" }],
				turn: { id: "t", handle: "cy_acme", started: 1, entryOffset: 0, responded: false },
			},
			builds: [],
			threads: new Map([
				["thread", {
					notes: [
						{ id: "n1", author: "member", handle: "di_acme", text: "?", ts: 1 },
						{ id: "n2", author: "planner", text: "!", ts: 2 },
					],
					resolver: "ed_acme",
				}],
			]),
			records: new Map([
				["decision", {
					owner: "fay_acme",
					resolver: "gus_acme",
					editors: ["hal_acme"],
					history: [{ choices: [], owner: "ivy_acme", at: 1 }],
					optionOrigins: { option: { origin: "human" as const, by: "jo_acme" } },
					findings: [
						{
							id: "f1",
							kind: "ask" as const,
							status: "ready" as const,
							ref: "kay_acme",
							by: "lou_acme",
							at: 1,
						},
						{
							id: "f2",
							kind: "research" as const,
							status: "ready" as const,
							ref: "request-id",
							by: "lou_acme",
							at: 2,
						},
					],
					whyBy: "mia_acme",
				}],
			]),
		});

		expect(logins.sort()).toEqual([
			"ana_acme",
			"bo_acme",
			"cy_acme",
			"di_acme",
			"ed_acme",
			"fay_acme",
			"gus_acme",
			"hal_acme",
			"ivy_acme",
			"jo_acme",
			"kay_acme",
			"lou_acme",
			"mia_acme",
		]);
	});
});

describe("the people who build a document", () => {
	it("are whoever started a build, whose machine ran one, or built it live, once each", () => {
		expect(
			builders({
				builds: [{ user: "U_ana" }, { user: "U_bo", machineOwner: "U_cy" }, { user: "U_ana" }],
				live: { user: "U_di" },
			}).sort(),
		).toEqual(["U_ana", "U_bo", "U_cy", "U_di"]);
		expect(builders({ builds: [] })).toEqual([]);
	});
});

describe("their pictures", () => {
	it("come from the stored sign-in of each login, whatever its casing, and only those with one", async () => {
		let storage = new MemoryStorage();
		await storage.users.put({ id: "U_ana", login: "Ana_Acme", avatarUrl: "https://a.test/1", now });
		await storage.users.put({ id: "U_bo", login: "bo_acme", avatarUrl: "", now });

		expect(
			await pictures(storage.users, { logins: ["ana_acme", "bo_acme", "nobody_acme"] }),
		).toEqual([{ login: "Ana_Acme", avatarUrl: "https://a.test/1" }]);
		expect(await pictures(storage.users, { logins: [] })).toEqual([]);
	});

	it("also come from a user ID, for the people a build names, once however it was found", async () => {
		let storage = new MemoryStorage();
		await storage.users.put({ id: "U_ana", login: "ana_acme", avatarUrl: "https://a.test/1", now });
		await storage.users.put({ id: "U_cy", login: "cy_acme", avatarUrl: "https://a.test/3", now });

		expect(
			await pictures(storage.users, { logins: ["ANA_ACME"], ids: ["U_ana", "U_cy", "U_gone"] }),
		).toEqual([
			{ login: "ana_acme", avatarUrl: "https://a.test/1" },
			{ login: "cy_acme", avatarUrl: "https://a.test/3" },
		]);
	});

	it("reach the whole room when someone it has not met is named, and only with a picture", () => {
		let sent: Array<{ topic: string; frame: Record<string, unknown> }> = [];
		let server = {
			publish: (topic: string, message: string) => sent.push({ topic, frame: JSON.parse(message) }),
		} as unknown as Server<SocketData>;

		introduce(server, "room-1", { login: "nell_acme", avatarUrl: "https://a.test/9" });
		introduce(server, "room-1", { login: "otto_acme", avatarUrl: "" });
		introduce(server, "room-1", { login: "pia_acme" });

		expect(sent).toHaveLength(1);
		expect(sent[0]!.topic).toBe("room:room-1");
		expect(sent[0]!.frame).toMatchObject({
			kind: "session:people",
			people: [{ login: "nell_acme", avatarUrl: "https://a.test/9" }],
		});
	});
});
