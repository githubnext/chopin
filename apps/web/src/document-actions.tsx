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
	let byId = new Map(retained.map(channel => [channel.id, channel]));
	for (let channel of channels) byId.set(channel.id, channel);
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

export function newestDocument(current: Api.Channel, replacement: Api.Channel): Api.Channel {
	return current.id === replacement.id && current.updatedAt > replacement.updatedAt
		? current
		: replacement;
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
	update: Pick<Api.Channel, "title" | "slug" | "updatedAt" | "archivedAt">,
): LoadedDocuments {
	for (let [repositoryId, state] of Object.entries(documents)) {
		if (!state.channels.some(channel => channel.id === documentId)) continue;
		return {
			...documents,
			[repositoryId]: {
				...state,
				channels: state.channels.map(channel =>
					channel.id === documentId && channel.updatedAt <= update.updatedAt
						? { ...channel, ...update }
						: channel
				),
			},
		};
	}
	return documents;
}
