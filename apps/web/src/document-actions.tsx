import * as Api from "./api";

export type DocumentLoadState =
	| { status: "loading"; channels: Api.Channel[]; nextCursor?: string }
	| { status: "ready"; channels: Api.Channel[]; nextCursor?: string }
	| { status: "error"; channels: Api.Channel[]; nextCursor?: string; message: string };

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

export function beginDocumentLoad(current?: DocumentLoadState): DocumentLoadState {
	return {
		status: "loading",
		channels: current?.channels ?? [],
		...(current?.nextCursor ? { nextCursor: current.nextCursor } : {}),
	};
}

export function completeDocumentPage(
	current: DocumentLoadState,
	channels: Api.Channel[],
	nextCursor?: string,
	replace = false,
	preserveMissing?: ReadonlySet<string>,
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

export function newestDocument(current: Api.Channel, replacement: Api.Channel): Api.Channel {
	if (current.id !== replacement.id) return replacement;
	let core = current.updatedAt > replacement.updatedAt ? current : replacement;
	return updateDocumentMetadata(core, newestDocumentMetadata(current, replacement));
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
