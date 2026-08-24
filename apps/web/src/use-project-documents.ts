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
	updateLoadedDocument,
} from "./document-actions";

import type { LoadedDocuments, ProjectDocuments } from "./document-actions";

export function useProjectDocuments(navigation?: Api.Navigation, includeArchived = false) {
	let [catalogue, setCatalogue] = useState<{
		includeArchived: boolean;
		documents: LoadedDocuments;
	}>(() => ({ includeArchived, documents: {} }));
	let includeArchivedRef = useRef(includeArchived);
	includeArchivedRef.current = includeArchived;
	let documents = catalogue.includeArchived === includeArchived ? catalogue.documents : {};
	let loads = useRef(new Map<string, AbortController>());
	let latestDocuments = useRef(new Map<string, Api.Channel>());

	let load = useCallback(async (project: Api.NavigationProject, cursor?: string) => {
		let id = project.repositoryId;
		let key = `${includeArchived ? "all" : "active"}:${id}`;
		if (loads.current.has(key)) return;
		let controller = new AbortController();
		loads.current.set(key, controller);
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
			if (loads.current.get(key) !== controller) return;
			let channels = page.channels.map(channel => {
				let latest = latestDocuments.current.get(channel.id);
				let accepted = latest ? newestDocument(latest, channel) : channel;
				latestDocuments.current.set(channel.id, accepted);
				return accepted;
			}).filter(channel => includeArchived || !channel.archivedAt);
			setCatalogue(current =>
				current.includeArchived !== includeArchived
					? current
					: {
						...current,
						documents: {
							...current.documents,
							[id]: completeDocumentPage(
								current.documents[id] ?? beginDocumentLoad(),
								channels,
								page.nextCursor,
								cursor === undefined,
							),
						},
					}
			);
		} catch (error) {
			if (controller.signal.aborted || loads.current.get(key) !== controller) return;
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
			if (loads.current.get(key) === controller) loads.current.delete(key);
		}
	}, [includeArchived]);

	useEffect(() => {
		let prefix = includeArchived ? "all:" : "active:";
		for (let [key, controller] of loads.current) {
			if (key.startsWith(prefix)) continue;
			controller.abort();
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
		for (let [key, controller] of loads.current) {
			let id = key.slice(key.indexOf(":") + 1);
			if (!available.has(id)) {
				controller.abort();
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
		for (let controller of loads.current.values()) controller.abort();
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
		void load(project);
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
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt" | "archivedAt">,
	) => {
		let latest = latestDocuments.current.get(documentId);
		if (!latest || latest.updatedAt <= update.updatedAt) {
			if (latest) latestDocuments.current.set(documentId, { ...latest, ...update });
		}
		setCatalogue(current => {
			if (current.includeArchived !== includeArchivedRef.current) return current;
			let existing = Object.values(current.documents).flatMap(state => state.channels)
				.find(value => value.id === documentId);
			if (existing && existing.updatedAt > update.updatedAt) return current;
			let documents = update.archivedAt && !includeArchivedRef.current
				? removeLoadedDocument(current.documents, documentId)
				: updateLoadedDocument(current.documents, documentId, update);
			return documents === current.documents ? current : { ...current, documents };
		});
	}, []);
	let removeDocument = useCallback((documentId: string) => {
		latestDocuments.current.delete(documentId);
		for (let controller of loads.current.values()) controller.abort();
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
