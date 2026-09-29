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
