import { expect, test } from "bun:test";
import * as Chat from "./service";

test("only a live server readiness turn may propose with the existing owner identity", async () => {
	let chat = Chat.create();
	chat.busy = true;
	chat.turn = { id: "turn" } as typeof chat.turn;
	chat.turnController = new AbortController();
	let context = {
		chat,
		activeOwner: async () => ({ ownerSessionId: "owner", release() {} }),
		auth: { sessions: { resolve: async () => ({ user: { id: "actual-owner" } }) } },
	} as unknown as Chat.Room;
	let room = Chat.documentRoom(context);
	expect(await room.readinessInvestigationRequest!()).toBeUndefined();
	chat.readiness = true;
	expect(await room.readinessInvestigationRequest!()).toEqual({
		userId: "actual-owner",
		entryId: "readiness:turn",
	});
	expect(room.currentMemberRequest!()).toBeUndefined();
	chat.turnController.abort();
	expect(await room.readinessInvestigationRequest!()).toBeUndefined();
});

test("an investigation proposal cannot reuse an owner lookup after its turn was stopped", async () => {
	let chat = Chat.create();
	chat.busy = true;
	chat.readiness = true;
	chat.turn = { id: "turn" } as typeof chat.turn;
	chat.turnController = new AbortController();
	let found = Promise.withResolvers<{ user: { id: string } }>();
	let context = {
		chat,
		activeOwner: async () => ({ ownerSessionId: "owner", release() {} }),
		auth: { sessions: { resolve: () => found.promise } },
	} as unknown as Chat.Room;
	let lookup = Chat.documentRoom(context).readinessInvestigationRequest!();
	await Bun.sleep(0);
	chat.turnController.abort();
	found.resolve({ user: { id: "actual-owner" } });
	expect(await lookup).toBeUndefined();
});

test("a live Build task draft can surface an investigation before attempting implementation", async () => {
	let chat = Chat.create();
	chat.busy = true;
	chat.turn = { id: "turn" } as typeof chat.turn;
	chat.turnController = new AbortController();
	chat.draft = { id: "draft", state: "running", planRevision: 1, turn: "turn" };
	let context = {
		chat,
		draft: "draft",
		activeOwner: async () => ({ ownerSessionId: "owner", release() {} }),
		auth: { sessions: { resolve: async () => ({ user: { id: "actual-owner" } }) } },
	} as unknown as Chat.Room;
	let room = Chat.documentRoom(context);
	expect(await room.readinessInvestigationRequest!()).toEqual({
		userId: "actual-owner",
		entryId: "readiness:turn",
	});
	chat.draft = undefined;
	expect(await room.readinessInvestigationRequest!()).toBeUndefined();
});
