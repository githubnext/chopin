import { expect, test } from "bun:test";

import * as Rooms from "../rooms";
import { spikeSettler, startSettle } from "./spike-settle";

import type { ServerInstructionDeps } from "../chat/server-instruction";
import type * as Chat from "../chat/service";
import type * as Service from "../plan/service";
import type { Socket } from "../wire";
import type { Investigation } from "@chopin/experiment/records";

const REPOSITORY = { id: "R_1", owner: "acme", name: "app", defaultBranch: "main" };

/** The settle path exactly as main.ts wires it, over real Rooms and fake Planner plumbing. */
function harness(
	options: { agent?: boolean; owner?: boolean; child?: boolean; attached?: boolean } = {},
) {
	let channelId = crypto.randomUUID();
	let record = {
		id: crypto.randomUUID(),
		documentId: channelId,
		requester: "U_requester",
		spike: { login: "maggie", settle: true },
	} as unknown as Investigation;
	let opened: Rooms.Room[] = [];
	let turns: { sessionId: string | undefined; repository: unknown; handle: string }[] = [];
	let deps: ServerInstructionDeps = {
		agent: options.agent ?? true,
		unavailable: () => false,
		owner: async () => options.owner ? { repository: REPOSITORY, release: () => {} } : undefined,
		transition: (_id, action) => action(),
		open: async room => {
			opened.push(room);
			return room.plan ??= {} as Service.Plan;
		},
		conversation: (_room, sessionId, repository) => {
			let chat = { waiting: [] as unknown[], running: undefined as Promise<void> | undefined };
			return { chat, sessionId, repository } as unknown as Chat.Room;
		},
		instruct: (context, instruction) => {
			let { sessionId, repository } = context as unknown as {
				sessionId?: string;
				repository: unknown;
			};
			turns.push({ sessionId, repository, handle: instruction.handle });
			context.chat.running = Promise.resolve();
		},
		evict: () => {},
	};
	let settler = spikeSettler({
		get: async () => record,
		list: async () => [record],
		mutate: async (_id, action) => action(record),
		start: (id, value) =>
			startSettle(
				{
					instruction: deps,
					channel: async () => options.child ? { parentChannelId: "parent" } : {},
					attached: options.attached === undefined ? undefined : async () => attachment.attached,
				},
				id,
				() => ({
					handle: value.spike!.login,
					text: "Settle the passage",
					said: "Settling",
				}),
			),
	});
	let attachment = { attached: options.attached ?? false };
	let cleanup = () => {
		let room = Rooms.get(channelId);
		if (room) Rooms.forget(room);
	};
	return { channelId, record, opened, turns, settler, cleanup, attachment, deps };
}

function socket(
	channelId: string,
	principalId: string,
	state: { canEdit?: boolean; closed?: boolean } = {},
): Socket {
	return {
		data: {
			room: channelId,
			client: crypto.randomUUID(),
			handle: "requester",
			principalId,
			sessionId: "S_requester",
			canEdit: state.canEdit ?? true,
			closed: state.closed ?? false,
			repositoryId: REPOSITORY.id,
			repositoryOwner: REPOSITORY.owner,
			repositoryName: REPOSITORY.name,
			repositoryDefaultBranch: REPOSITORY.defaultBranch,
		},
	} as unknown as Socket;
}

test("no socket ever claims the Planner for a settle: the requester's, a viewer's, a closed one or another person's", async () => {
	for (
		let state of [
			{ principalId: "U_requester" },
			{ principalId: "U_requester", canEdit: false },
			{ principalId: "U_requester", closed: true },
			{ principalId: "U_other" },
		]
	) {
		let context = harness();
		try {
			let room = Rooms.join(socket(context.channelId, state.principalId, state));
			room.plan = {} as Service.Plan;
			await context.settler.settle(context.channelId, context.record.id);
			expect(context.turns).toEqual([]);
			expect(context.record.spike?.settle).toBe(true);
		} finally {
			context.cleanup();
		}
	}
});

test("an existing owner settles it in a reopened room", async () => {
	let context = harness({ owner: true });
	try {
		expect(Rooms.get(context.channelId)).toBeUndefined();
		await context.settler.pending(context.channelId);
		expect(context.opened.map(room => room.id)).toEqual([context.channelId]);
		expect(context.turns).toEqual([
			{ sessionId: undefined, repository: REPOSITORY, handle: "maggie" },
		]);
		expect(context.record.spike?.settle).toBeUndefined();
	} finally {
		context.cleanup();
	}
});

test("without an owner, nothing is claimed and the settle stays pending", async () => {
	let context = harness();
	try {
		// Someone else's socket never claims for the requester.
		Rooms.join(socket(context.channelId, "U_other")).plan = {} as Service.Plan;
		await context.settler.settle(context.channelId, context.record.id);
		expect(context.turns).toEqual([]);
		expect(context.opened).toEqual([]);
		expect(context.record.spike?.settle).toBe(true);
	} finally {
		context.cleanup();
	}
});

test("with the agent off, no turn starts and the settle stays pending", async () => {
	let context = harness({ agent: false, owner: true });
	try {
		await context.settler.pending(context.channelId);
		expect(context.turns).toEqual([]);
		expect(context.record.spike?.settle).toBe(true);
	} finally {
		context.cleanup();
	}
});

test("under the remote harness a settle waits for an attached Planner, and attaching wakes it", async () => {
	let context = harness({ owner: true, attached: false });
	try {
		await context.settler.pending(context.channelId);
		expect(context.turns).toEqual([]);
		expect(context.opened).toEqual([]);
		expect(context.record.spike?.settle).toBe(true);
		// What main.ts does when the attachment changes to attached.
		context.attachment.attached = true;
		await context.settler.pending(context.channelId);
		expect(context.turns).toEqual([
			{ sessionId: undefined, repository: REPOSITORY, handle: "maggie" },
		]);
		expect(context.record.spike?.settle).toBeUndefined();
	} finally {
		context.cleanup();
	}
});

test("a child document's settle is dropped rather than retried forever", async () => {
	let context = harness({ owner: true, child: true });
	try {
		await context.settler.pending(context.channelId);
		expect(context.turns).toEqual([]);
		expect(context.record.spike?.settle).toBeUndefined();
	} finally {
		context.cleanup();
	}
});
