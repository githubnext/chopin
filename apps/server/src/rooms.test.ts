import { expect, test } from "bun:test";

import * as Rooms from "./rooms";

import type { Socket } from "./wire";

test("a Planner hold opens a memberless room, cancels eviction, and releases without affecting membership", () => {
	let id = crypto.randomUUID();
	let first = Rooms.hold(id);
	let room = first.room;
	try {
		expect(Rooms.get(id)).toBe(room);
		expect(room.members.size).toBe(0);
		expect(room.holds).toBe(1);
		room.eviction = setTimeout(() => {
			throw new Error("held room evicted");
		}, 10);
		let second = Rooms.hold(id);
		expect(second.room).toBe(room);
		expect(room.eviction).toBeUndefined();
		expect(room.holds).toBe(2);
		let socket = { data: { room: id, client: "client", handle: "ana" } } as Socket;
		expect(Rooms.join(socket)).toBe(room);
		first.release();
		first.release();
		expect(room.holds).toBe(1);
		Rooms.leave(socket);
		expect(room.members.size).toBe(0);
		expect(room.holds).toBe(1);
		second.release();
		expect(room.holds).toBe(0);
	} finally {
		Rooms.forget(room);
	}
});

test("a member is listed with the picture GitHub gave their login, and a demo actor with its roster's", () => {
	let id = crypto.randomUUID();
	let room = Rooms.hold(id);
	let ana = {
		data: { room: id, client: "a", handle: "ana_acme", avatarUrl: "https://avatars.test/u/1" },
	} as Socket;
	let bare = { data: { room: id, client: "b", handle: "bo" } } as Socket;
	let lily = {
		data: {
			room: id,
			client: "c",
			handle: "demo:lily",
			actor: { id: "demo:lily", name: "Lily", avatar: "/demo/lily.svg" },
		},
	} as Socket;
	try {
		for (let socket of [lily, bare, ana]) Rooms.join(socket);
		expect(Rooms.members(room.room)).toEqual([
			{ handle: "ana_acme", client: "a", avatarUrl: "https://avatars.test/u/1" },
			{ handle: "bo", client: "b" },
			{ actor: { name: "Lily", avatar: "/demo/lily.svg" }, handle: "demo:lily", client: "c" },
		]);
		expect(Rooms.member(ana)).toEqual({
			handle: "ana_acme",
			client: "a",
			avatarUrl: "https://avatars.test/u/1",
		});
	} finally {
		room.release();
		Rooms.forget(room.room);
	}
});
