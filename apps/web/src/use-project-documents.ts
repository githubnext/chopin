import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as Api from "./api";
import {
	beginDocumentLoad,
	completeDocumentPage,
	failDocumentLoad,
	newestDocument,
	projectDocuments,
	removeLoadedDocument,
	replaceLoadedDocument,
	updateDocumentMetadata,
	updateLoadedDocument,
} from "./document-actions";

import type { DocumentMetadata, LoadedDocuments, ProjectDocuments } from "./document-actions";

type CatalogueLoad = {
	controller: AbortController;
	queued?: Api.NavigationProject;
};

export function useProjectDocuments(navigation?: Api.Navigation, includeArchived = false) {
	let [catalogue, setCatalogue] = useState<{
		includeArchived: boolean;
		documents: LoadedDocuments;
	}>(() => ({ includeArchived, documents: {} }));
	let includeArchivedRef = useRef(includeArchived);
	includeArchivedRef.current = includeArchived;
	let documents = catalogue.includeArchived === includeArchived ? catalogue.documents : {};
	let loads = useRef(new Map<string, CatalogueLoad>());
	let latestDocuments = useRef(new Map<string, Api.Channel>());

	let load = useCallback(async (
		project: Api.NavigationProject,
		cursor?: string,
		queue = false,
	) => {
		let id = project.repositoryId;
		let key = `${includeArchived ? "all" : "active"}:${id}`;
		let active = loads.current.get(key);
		if (active) {
			if (queue && cursor === undefined) active.queued = project;
			return;
		}
		let controller = new AbortController();
		let currentLoad: CatalogueLoad = { controller };
		let knownDocuments = cursor === undefined
			? new Set(latestDocuments.current.keys())
			: undefined;
		loads.current.set(key, currentLoad);
		setCatalogue(current => {
			let catalogueDocuments = current.includeArchived === includeArchived
				? current.documents
				: {};
			return {
				includeArchived,
				documents: {
					...catalogueDocuments,
					[id]: beginDocumentLoad(catalogueDocuments[id]),
				},
			};
		});
		try {
			let page = await Api.channels(
				project.repositoryOwner,
				project.repositoryName,
				{ cursor, includeArchived, signal: controller.signal },
			);
			if (loads.current.get(key) !== currentLoad) return;
			let channels = page.channels.map(channel => {
				let latest = latestDocuments.current.get(channel.id);
				let accepted = latest ? newestDocument(latest, channel) : channel;
				latestDocuments.current.set(channel.id, accepted);
				return accepted;
			}).filter(channel => includeArchived || !channel.archivedAt);
			setCatalogue(current => {
				if (current.includeArchived !== includeArchived) return current;
				let loaded = current.documents[id] ?? beginDocumentLoad();
				let preserveMissing = knownDocuments
					? new Set(
						loaded.channels.filter(channel => !knownDocuments.has(channel.id))
							.map(channel => channel.id),
					)
					: undefined;
				return {
					...current,
					documents: {
						...current.documents,
						[id]: completeDocumentPage(
							loaded,
							channels,
							page.nextCursor,
							cursor === undefined,
							preserveMissing,
						),
					},
				};
			});
		} catch (error) {
			if (controller.signal.aborted || loads.current.get(key) !== currentLoad) return;
			setCatalogue(current =>
				current.includeArchived !== includeArchived
					? current
					: {
						...current,
						documents: {
							...current.documents,
							[id]: failDocumentLoad(
								current.documents[id] ?? beginDocumentLoad(),
								error,
							),
						},
					}
			);
		} finally {
			if (loads.current.get(key) === currentLoad) {
				loads.current.delete(key);
				if (currentLoad.queued) void load(currentLoad.queued);
			}
		}
	}, [includeArchived]);

	useEffect(() => {
		let prefix = includeArchived ? "all:" : "active:";
		for (let [key, active] of loads.current) {
			if (key.startsWith(prefix)) continue;
			active.queued = undefined;
			active.controller.abort();
			loads.current.delete(key);
		}
		setCatalogue(current =>
			current.includeArchived === includeArchived
				? current
				: { includeArchived, documents: {} }
		);
	}, [includeArchived]);

	useEffect(() => {
		if (!navigation) return;
		let available = new Set(
			navigation.projects.filter(project => project.available)
				.map(project => project.repositoryId),
		);
		for (let [key, active] of loads.current) {
			let id = key.slice(key.indexOf(":") + 1);
			if (!available.has(id)) {
				active.queued = undefined;
				active.controller.abort();
				loads.current.delete(key);
			}
		}
		setCatalogue(current => {
			if (current.includeArchived !== includeArchived) return current;
			let entries = Object.entries(current.documents).filter(([id]) => available.has(id));
			return entries.length === Object.keys(current.documents).length
				? current
				: { ...current, documents: Object.fromEntries(entries) };
		});
		for (let project of navigation.projects) {
			let state = documents[project.repositoryId];
			let key = `${includeArchived ? "all" : "active"}:${project.repositoryId}`;
			if (
				project.available
				&& (!state || (state.status === "loading" && !loads.current.has(key)))
			) void load(project);
		}
	}, [documents, includeArchived, load, navigation]);

	useEffect(() => () => {
		for (let active of loads.current.values()) {
			active.queued = undefined;
			active.controller.abort();
		}
		loads.current.clear();
	}, []);

	let projects = useMemo(
		() => navigation ? projectDocuments(navigation, documents) : [],
		[navigation, documents],
	);
	let loadMore = useCallback((entry: ProjectDocuments) => {
		if (entry.documents.status !== "ready" || !entry.documents.nextCursor) return;
		void load(entry.project, entry.documents.nextCursor);
	}, [load]);
	let refreshProject = useCallback((project: Api.NavigationProject) => {
		void load(project, undefined, true);
	}, [load]);
	let upsertDocument = useCallback((channel: Api.Channel) => {
		let latest = latestDocuments.current.get(channel.id);
		let accepted = latest ? newestDocument(latest, channel) : channel;
		latestDocuments.current.set(channel.id, accepted);
		setCatalogue(current => {
			let visible = current.includeArchived === includeArchivedRef.current;
			if (!visible) return current;
			let existing = Object.values(current.documents).flatMap(state => state.channels)
				.find(value => value.id === channel.id);
			accepted = existing ? newestDocument(existing, accepted) : accepted;
			latestDocuments.current.set(channel.id, accepted);
			let documents = accepted.archivedAt && !includeArchivedRef.current
				? removeLoadedDocument(current.documents, accepted.id)
				: replaceLoadedDocument(current.documents, accepted);
			return documents === current.documents ? current : { ...current, documents };
		});
	}, []);
	let updateDocument = useCallback((
		documentId: string,
		update: DocumentMetadata,
	) => {
		let latest = latestDocuments.current.get(documentId);
		if (latest) latestDocuments.current.set(documentId, updateDocumentMetadata(latest, update));
		setCatalogue(current => {
			if (current.includeArchived !== includeArchivedRef.current) return current;
			let existing = Object.values(current.documents).flatMap(state => state.channels)
				.find(value => value.id === documentId);
			if (!existing) return current;
			let accepted = updateDocumentMetadata(existing, update);
			let known = latestDocuments.current.get(documentId);
			if (known) accepted = newestDocument(known, accepted);
			latestDocuments.current.set(documentId, accepted);
			let documents = accepted.archivedAt && !includeArchivedRef.current
				? removeLoadedDocument(current.documents, documentId)
				: updateLoadedDocument(current.documents, documentId, accepted);
			return documents === current.documents ? current : { ...current, documents };
		});
	}, []);
	let removeDocument = useCallback((documentId: string) => {
		latestDocuments.current.delete(documentId);
		for (let active of loads.current.values()) {
			active.queued = undefined;
			active.controller.abort();
		}
		loads.current.clear();
		setCatalogue(current => ({ ...current, documents: {} }));
	}, []);

	return {
		loadMore,
		projects,
		refreshProject,
		removeDocument,
		updateDocument,
		upsertDocument,
	};
}
