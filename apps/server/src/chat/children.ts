/**
 * A root document's children, as its one Chat and Planner see them.
 *
 * Every read re-asks storage whether the child still belongs to this root, in
 * this repository, unarchived: a child id from a prompt, a tool argument or a
 * queued message is a claim, not a capability.
 */
import { isChannelId } from "../channels/id";
import * as Service from "../plan/service";

import type { Server } from "bun";
import type { DocumentRoom } from "../agent/tools";
import type { Plan } from "../plan/service";
import type { ChannelRecord } from "../storage/model";
import type { ChannelStore } from "../storage/port";
import type { SocketData } from "../wire";

export const MAX_CHILDREN = 100;

export type ChildSummary = { id: string; title: string; createdAt: string };

export type ChildDocuments = {
	list(): Promise<ChildSummary[]>;
	resolve(childId: string): Promise<ChildSummary | undefined>;
	open<T>(childId: string, action: (child: DocumentRoom) => Promise<T>): Promise<T>;
};

export type ChildDocumentDeps = {
	rootId: string;
	repositoryId: string;
	channels: Pick<ChannelStore, "get" | "children">;
	server: Server<SocketData>;
	/** Holds the child's room open under its document transition while `action` runs. */
	withChildPlan: <T>(childId: string, action: (plan: Plan) => Promise<T>) => Promise<T>;
};

function childRoom(id: string, plan: Plan, server: Server<SocketData>): DocumentRoom {
	return {
		id,
		plan,
		server,
		publish: mutation => Service.publish(plan, server, id, mutation, { agent: true }),
		persist: () => Service.persist(plan),
		exclusive: action => Service.exclusive(plan, action),
		anchors: () => Service.anchors(plan, server, id),
		changes: found => Service.changes(plan, server, id, found),
	};
}

function summary(child: ChannelRecord): ChildSummary {
	return { id: child.id, title: child.title, createdAt: child.createdAt.toISOString() };
}

/** The one children failure whose text is written for the model. */
export class UnknownChild extends Error {
	constructor() {
		super("no such child document of this document");
	}
}

export function createChildDocuments(deps: ChildDocumentDeps): ChildDocuments {
	let belongs = (child: ChannelRecord | undefined): child is ChannelRecord =>
		!!child && child.parentChannelId === deps.rootId
		&& child.repositoryId === deps.repositoryId && !child.archivedAt;
	let rootLive = async () => {
		let root = await deps.channels.get(deps.rootId);
		return !!root && !root.parentChannelId && !root.archivedAt
			&& root.repositoryId === deps.repositoryId;
	};
	let resolve = async (childId: string) => {
		if (typeof childId !== "string" || !isChannelId(childId) || childId === deps.rootId) {
			return undefined;
		}
		if (!await rootLive()) return undefined;
		let child = await deps.channels.get(childId);
		return belongs(child) ? summary(child) : undefined;
	};
	return {
		async list() {
			if (!await rootLive()) return [];
			return (await deps.channels.children(deps.rootId, MAX_CHILDREN)).filter(belongs).map(summary);
		},
		resolve,
		async open(childId, action) {
			if (!await resolve(childId)) throw new UnknownChild();
			return deps.withChildPlan(childId, async plan => {
				// Archive and delete take the same transition, so this answer holds for the action.
				if (!await resolve(childId)) throw new UnknownChild();
				return action(childRoom(childId, plan, deps.server));
			});
		},
	};
}
