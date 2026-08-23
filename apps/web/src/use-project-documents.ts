import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as Api from "./api";
import {
	beginDocumentLoad,
	completeDocumentPage,
	failDocumentLoad,
	projectDocuments,
	replaceLoadedDocument,
	updateLoadedDocument,
} from "./document-actions";

import type { LoadedDocuments, ProjectDocuments } from "./document-actions";

export function useProjectDocuments(navigation?: Api.Navigation) {
	let [documents, setDocuments] = useState<LoadedDocuments>({});
	let loads = useRef(new Map<string, AbortController>());

	let load = useCallback(async (project: Api.NavigationProject, cursor?: string) => {
		let id = project.repositoryId;
		if (loads.current.has(id)) return;
		let controller = new AbortController();
		loads.current.set(id, controller);
		setDocuments(current => ({
			...current,
			[id]: beginDocumentLoad(current[id]),
		}));
		try {
			let page = await Api.channels(
				project.repositoryOwner,
				project.repositoryName,
				cursor,
				undefined,
				controller.signal,
			);
			if (loads.current.get(id) !== controller) return;
			setDocuments(current => ({
				...current,
				[id]: completeDocumentPage(
					current[id] ?? beginDocumentLoad(),
					page.channels,
					page.nextCursor,
				),
			}));
		} catch (error) {
			if (controller.signal.aborted || loads.current.get(id) !== controller) return;
			setDocuments(current => ({
				...current,
				[id]: failDocumentLoad(current[id] ?? beginDocumentLoad(), error),
			}));
		} finally {
			if (loads.current.get(id) === controller) loads.current.delete(id);
		}
	}, []);

	useEffect(() => {
		if (!navigation) return;
		let available = new Set(
			navigation.projects.filter(project => project.available)
				.map(project => project.repositoryId),
		);
		for (let [id, controller] of loads.current) {
			if (!available.has(id)) controller.abort();
		}
		setDocuments(current => {
			let entries = Object.entries(current).filter(([id]) => available.has(id));
			return entries.length === Object.keys(current).length
				? current
				: Object.fromEntries(entries);
		});
		for (let project of navigation.projects) {
			let state = documents[project.repositoryId];
			if (
				project.available
				&& (!state || (state.status === "loading" && !loads.current.has(project.repositoryId)))
			) void load(project);
		}
	}, [documents, load, navigation]);

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
		setDocuments(current => replaceLoadedDocument(current, channel));
	}, []);
	let updateDocument = useCallback((
		documentId: string,
		update: Pick<Api.Channel, "title" | "slug" | "updatedAt">,
	) => {
		setDocuments(current => updateLoadedDocument(current, documentId, update));
	}, []);

	return { loadMore, projects, refreshProject, updateDocument, upsertDocument };
}
