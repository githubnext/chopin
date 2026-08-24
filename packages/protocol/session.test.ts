import { describe, expect, it } from "bun:test";

import type { Session } from "./index";

describe("session archive frames", () => {
	it("carries management, archive and deletion state", () => {
		let hello: Session.Hello = {
			kind: "session:hello",
			ts: 1,
			channelId: "channel",
			title: "Archived plan",
			slug: "archived-plan",
			updatedAt: "2026-08-24T12:00:00.000Z",
			descriptionRevision: 1,
			description: "Plan for archival behavior",
			you: { handle: "mona", client: "first" },
			members: [{ handle: "mona", client: "first" }],
			canEdit: false,
			canManage: true,
			archivedAt: "2026-08-24T12:00:00.000Z",
			backgroundJobs: true,
			webResearch: true,
			chatReferences: true,
			chatSendAcks: true,
		};
		let channel: Session.Channel = {
			kind: "session:channel",
			ts: 2,
			channelId: "channel",
			title: "Archived plan",
			slug: "archived-plan",
			updatedAt: "2026-08-24T12:00:00.000Z",
			descriptionRevision: 1,
			description: "Plan for archival behavior",
			canManage: true,
			archivedAt: "2026-08-24T12:00:00.000Z",
		};
		let access: Session.Access = {
			kind: "session:access",
			ts: 3,
			canEdit: false,
			canManage: true,
		};
		let deleted: Session.Deleted = {
			kind: "session:deleted",
			ts: 4,
			channelId: "channel",
		};
		let outgoing: Session.Outgoing[] = [hello, channel, access, deleted];

		expect(outgoing.map(frame => frame.kind)).toEqual([
			"session:hello",
			"session:channel",
			"session:access",
			"session:deleted",
		]);
		expect(hello).toMatchObject({ canEdit: false, canManage: true });
		expect(channel.archivedAt).toBe(hello.archivedAt);
		expect(deleted.channelId).toBe(hello.channelId);
	});
});
