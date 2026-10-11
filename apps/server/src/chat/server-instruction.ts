import * as Rooms from "../rooms";

import type * as Service from "../plan/service";
import type * as Chat from "./service";

export type Instruction = { handle: string; text: string; said: string };

export type ServerInstructionDeps = {
	agent: boolean;
	unavailable: (channelId: string) => boolean;
	/** The channel's existing Planner owner, if one is bound. */
	owner: (
		channelId: string,
	) => Promise<{ repository: Chat.Room["repository"]; release: () => void } | undefined>;
	transition: <T>(channelId: string, action: () => Promise<T>) => Promise<T>;
	/** Attach the document to a held room, reopening it if it was evicted. */
	open: (room: Rooms.Room) => Promise<Service.Plan>;
	conversation: (
		room: Rooms.Room,
		claimantSessionId: string | undefined,
		repository: Chat.Room["repository"],
	) => Chat.Room;
	instruct: (context: Chat.Room, instruction: Instruction) => void | Promise<void>;
	evict: (room: Rooms.Room) => void;
};

/**
 * Start a Planner turn nobody typed, and say whether Chat accepted it (started or queued).
 * `claimant` is a user whose open, writable socket in the room may claim an unowned Planner;
 * without one, only an existing owner will do, and a room evicted since is reopened for it.
 */
export async function serverInstruction(
	deps: ServerInstructionDeps,
	channelId: string,
	compose: (plan: Service.Plan) => Instruction | undefined,
	claimant?: string,
): Promise<boolean> {
	if (!deps.agent || deps.unavailable(channelId)) return false;
	let opened = Rooms.get(channelId)?.plan;
	if (opened && !compose(opened)) return false;
	let socket = claimant
		? [...(Rooms.get(channelId)?.members.values() ?? [])].find(ws =>
			ws.data.principalId === claimant && ws.data.canEdit && !ws.data.closed
		)
		: undefined;
	let repository: Chat.Room["repository"] | undefined;
	if (socket) {
		repository = {
			id: socket.data.repositoryId,
			owner: socket.data.repositoryOwner,
			name: socket.data.repositoryName,
			defaultBranch: socket.data.repositoryDefaultBranch,
		};
	} else {
		let binding = await deps.owner(channelId);
		if (!binding) return false;
		repository = binding.repository;
		binding.release();
	}
	return deps.transition(channelId, async () => {
		await Rooms.get(channelId)?.closing;
		let held = Rooms.hold(channelId);
		let release = () => {
			held.release();
			deps.evict(held.room);
		};
		let running = false;
		try {
			let current = await deps.open(held.room);
			let instruction = compose(current);
			if (!instruction) return false;
			let context = deps.conversation(held.room, socket?.data.sessionId, repository);
			let before = context.chat.running;
			let waiting = context.chat.waiting.length;
			await deps.instruct(context, instruction);
			if (context.chat.running) {
				running = true;
				void context.chat.running.finally(release).catch(() => {});
			}
			return (!!context.chat.running && context.chat.running !== before)
				|| context.chat.waiting.length > waiting;
		} finally {
			if (!running) release();
		}
	});
}
