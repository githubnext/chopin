import * as Api from "./api";

import type { Sidebar } from "@chopin/protocol";

type LoadedPages = {
	channels: Api.Channel[];
	nextCursor?: string;
	unansweredDecisions?: number;
};

export type DocumentLoadState =
	| LoadedPages & { status: "loading" }
	| LoadedPages & { status: "ready" }
	| LoadedPages & { status: "error"; message: string };

export type DecisionCounts = Pick<
	Sidebar.Decisions,
	"channelId" | "repositoryId" | "unanswered" | "repositoryUnanswered" | "revision"
>;

export type DecisionSnapshot = Pick<
	Sidebar.Snapshot,
	"repositoryId" | "repositoryUnanswered" | "documents"
>;

export type LoadedDocuments = Record<string, DocumentLoadState>;

export type ProjectDocuments = {
	project: Api.NavigationProject;
	documents: DocumentLoadState | { status: "unavailable"; channels: [] };
};

export type DocumentMetadata = Pick<
	Api.Channel,
	"title" | "slug" | "updatedAt" | "descriptionRevision" | "description" | "archivedAt"
>;

export function projectDocuments(
	navigation: Api.Navigation,
	documents: LoadedDocuments,
): ProjectDocuments[] {
	return navigation.projects.map(project => ({
		project,
		documents: !project.available
			? { status: "unavailable", channels: [] }
			: documents[project.repositoryId] ?? beginDocumentLoad(),
	}));
}

function retainedTotal(current?: DocumentLoadState) {
	return current?.unansweredDecisions === undefined
		? {}
		: { unansweredDecisions: current.unansweredDecisions };
}

export function beginDocumentLoad(current?: DocumentLoadState): DocumentLoadState {
	return {
		status: "loading",
		channels: current?.channels ?? [],
		...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
		...retainedTotal(current),
	};
}

export function completeDocumentPage(
	current: DocumentLoadState,
	channels: Api.Channel[],
	nextCursor?: string,
	replace = false,
	preserveMissing?: ReadonlySet<string>,
	unansweredDecisions = current.unansweredDecisions,
): DocumentLoadState {
	let retained = replace
		? current.channels.filter(channel => preserveMissing?.has(channel.id))
		: current.channels;
	let currentById = new Map(current.channels.map(channel => [channel.id, channel]));
	let byId = new Map(retained.map(channel => [channel.id, channel]));
	for (let channel of channels) {
		let existing = byId.get(channel.id) ?? currentById.get(channel.id);
		byId.set(channel.id, existing ? newestDocument(existing, channel) : channel);
	}
	return {
		status: "ready",
		channels: [...byId.values()],
		...(nextCursor ? { nextCursor } : {}),
		...(unansweredDecisions === undefined ? {} : { unansweredDecisions }),
	};
}

export function failDocumentLoad(
	current: DocumentLoadState,
	error: unknown,
): DocumentLoadState {
	return {
		status: "error",
		channels: current.channels,
		...(current.nextCursor ? { nextCursor: current.nextCursor } : {}),
		...retainedTotal(current),
		message: error instanceof Error ? error.message : "Could not load documents",
	};
}

function sameMetadata(current: DocumentMetadata, replacement: DocumentMetadata): boolean {
	return current.title === replacement.title
		&& current.slug === replacement.slug
		&& current.updatedAt === replacement.updatedAt
		&& current.archivedAt === replacement.archivedAt
		&& current.descriptionRevision === replacement.descriptionRevision
		&& current.description === replacement.description;
}

export function newestDocumentMetadata(
	current: DocumentMetadata,
	replacement: DocumentMetadata,
): DocumentMetadata {
	let core = current.updatedAt > replacement.updatedAt ? current : replacement;
	let generated = current.descriptionRevision > replacement.descriptionRevision
		? current
		: replacement;
	let merged: DocumentMetadata = {
		title: core.title,
		slug: core.slug,
		updatedAt: core.updatedAt,
		descriptionRevision: generated.descriptionRevision,
		...(core.archivedAt ? { archivedAt: core.archivedAt } : {}),
		...(generated.description !== undefined ? { description: generated.description } : {}),
	};
	if (sameMetadata(current, merged)) return current;
	return merged;
}

export function updateDocumentMetadata(
	current: Api.Channel,
	replacement: DocumentMetadata,
): Api.Channel {
	let metadata = newestDocumentMetadata(current, replacement);
	if (sameMetadata(current, metadata)) return current;
	let next: Api.Channel = {
		...current,
		title: metadata.title,
		slug: metadata.slug,
		updatedAt: metadata.updatedAt,
		descriptionRevision: metadata.descriptionRevision,
	};
	if (metadata.archivedAt === undefined) delete next.archivedAt;
	else next.archivedAt = metadata.archivedAt;
	if (metadata.description === undefined) delete next.description;
	else next.description = metadata.description;
	return next;
}

function withDecisions(
	channel: Api.Channel,
	revision: number,
	unansweredDecisions: number | undefined,
): Api.Channel {
	if (channel.revision === revision && channel.unansweredDecisions === unansweredDecisions) {
		return channel;
	}
	let next: Api.Channel = { ...channel, revision };
	if (unansweredDecisions === undefined) delete next.unansweredDecisions;
	else next.unansweredDecisions = unansweredDecisions;
	return next;
}

export function newestDocument(current: Api.Channel, replacement: Api.Channel): Api.Channel {
	if (current.id !== replacement.id) return replacement;
	let core = current.updatedAt > replacement.updatedAt ? current : replacement;
	let decisions = current.revision > replacement.revision ? current : replacement;
	return withDecisions(
		updateDocumentMetadata(core, newestDocumentMetadata(current, replacement)),
		decisions.revision,
		decisions.unansweredDecisions,
	);
}

export function replaceLoadedDocument(
	documents: LoadedDocuments,
	replacement: Api.Channel,
): LoadedDocuments {
	let current = documents[replacement.repositoryId];
	if (!current) {
		return {
			...documents,
			[replacement.repositoryId]: { status: "loading", channels: [replacement] },
		};
	}
	let found = current.channels.some(channel => channel.id === replacement.id);
	return {
		...documents,
		[replacement.repositoryId]: {
			...current,
			channels: found
				? current.channels.map(channel =>
					channel.id === replacement.id ? newestDocument(channel, replacement) : channel
				)
				: [...current.channels, replacement],
		},
	};
}

export function removeLoadedDocument(
	documents: LoadedDocuments,
	documentId: string,
): LoadedDocuments {
	for (let [repositoryId, state] of Object.entries(documents)) {
		if (!state.channels.some(channel => channel.id === documentId)) continue;
		return {
			...documents,
			[repositoryId]: {
				...state,
				channels: state.channels.filter(channel => channel.id !== documentId),
			},
		};
	}
	return documents;
}

export function updateLoadedDocument(
	documents: LoadedDocuments,
	documentId: string,
	update: DocumentMetadata,
): LoadedDocuments {
	for (let [repositoryId, state] of Object.entries(documents)) {
		if (!state.channels.some(channel => channel.id === documentId)) continue;
		let changed = false;
		let channels = state.channels.map(channel => {
			if (channel.id !== documentId) return channel;
			let next = updateDocumentMetadata(channel, update);
			if (next !== channel) changed = true;
			return next;
		});
		if (!changed) return documents;
		return {
			...documents,
			[repositoryId]: {
				...state,
				channels,
			},
		};
	}
	return documents;
}

export function replaceProjectTotal(
	documents: LoadedDocuments,
	repositoryId: string,
	unansweredDecisions: number,
): LoadedDocuments {
	let current = documents[repositoryId];
	if (!current || current.unansweredDecisions === unansweredDecisions) return documents;
	return { ...documents, [repositoryId]: { ...current, unansweredDecisions } };
}

export type LiveTotal = { updates: number; total: number };

export type HttpTotal = {
	/** The total to show: the HTTP one, unless a live total arrived during the read. */
	total?: number;
	superseded: boolean;
	/**
	 * Totals carry no ordering key, so a superseded read that disagrees cannot say
	 * which is newer. Only a fresh snapshot, ordered after every live frame, can.
	 */
	conflict: boolean;
};

export function settleHttpTotal(
	live: LiveTotal | undefined,
	updatesAtRequest: number | undefined,
	total: number | undefined,
): HttpTotal {
	if (!live || live.updates === updatesAtRequest) {
		return { total, superseded: false, conflict: false };
	}
	return {
		total: live.total,
		superseded: true,
		conflict: total !== undefined && total !== live.total,
	};
}

export function staleDecisionCounts(
	known: Pick<Api.Channel, "id" | "revision"> | undefined,
	counts: DecisionCounts,
): boolean {
	return known?.id === counts.channelId && known.revision > counts.revision;
}

export function acceptDecisionCounts(
	channel: Api.Channel,
	counts: DecisionCounts | undefined,
): Api.Channel {
	if (!counts || counts.channelId !== channel.id || staleDecisionCounts(channel, counts)) {
		return channel;
	}
	return withDecisions(channel, counts.revision, counts.unanswered);
}

export function applyDecisionCounts(
	documents: LoadedDocuments,
	counts: DecisionCounts,
): LoadedDocuments {
	let current = documents[counts.repositoryId];
	if (!current || current.channels.some(channel => staleDecisionCounts(channel, counts))) {
		return documents;
	}
	let changed = false;
	let channels = current.channels.map(channel => {
		let next = acceptDecisionCounts(channel, counts);
		if (next !== channel) changed = true;
		return next;
	});
	if (!changed && current.unansweredDecisions === counts.repositoryUnanswered) return documents;
	return {
		...documents,
		[counts.repositoryId]: {
			...current,
			channels: changed ? channels : current.channels,
			unansweredDecisions: counts.repositoryUnanswered,
		},
	};
}

export function snapshotDecisionCounts(snapshot: DecisionSnapshot): DecisionCounts[] {
	return snapshot.documents.map(document => ({
		...document,
		repositoryId: snapshot.repositoryId,
		repositoryUnanswered: snapshot.repositoryUnanswered,
	}));
}

export function applyDecisionSnapshot(
	documents: LoadedDocuments,
	snapshot: DecisionSnapshot,
): LoadedDocuments {
	let current = documents[snapshot.repositoryId];
	if (!current) return documents;
	let counts = new Map(
		snapshotDecisionCounts(snapshot).map(document => [document.channelId, document]),
	);
	let changed = false;
	let channels = current.channels.map(channel => {
		let next = acceptDecisionCounts(channel, counts.get(channel.id));
		if (next !== channel) changed = true;
		return next;
	});
	if (!changed && current.unansweredDecisions === snapshot.repositoryUnanswered) return documents;
	return {
		...documents,
		[snapshot.repositoryId]: {
			...current,
			channels: changed ? channels : current.channels,
			unansweredDecisions: snapshot.repositoryUnanswered,
		},
	};
}
