import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as Api from "./api";
import {
	beginResearchLoad,
	completeResearchLoad,
	currentResearchRequest,
	failResearchLoad,
	removeLoadedResearchChannel,
	researchByChannel,
	upsertLoadedResearch,
} from "./research-navigation";

import type { Research } from "@chopin/protocol";
import type { ProjectDocuments } from "./document-actions";
import type { LoadedResearch } from "./research-navigation";

export function useProjectResearch(
	navigation?: Api.Navigation,
	documents: ProjectDocuments[] = [],
	includeArchived = false,
) {
	let [research, setResearch] = useState<LoadedResearch>({});
	let loads = useRef(new Map<string, AbortController>());
	let projects = useRef(new Map<string, Api.NavigationProject>());
	let invalidations = useRef(new Map<string, number>());
	let retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	projects.current = new Map(
		(navigation?.projects ?? []).map(project => [project.repositoryId, project]),
	);

	let load = useCallback(async (project: Api.NavigationProject, replace = false) => {
		let id = project.repositoryId;
		let pending = loads.current.get(id);
		if (pending && !replace) return false;
		pending?.abort();
		let controller = new AbortController();
		loads.current.set(id, controller);
		setResearch(current => ({
			...current,
			[id]: beginResearchLoad(current[id]),
		}));
		try {
			let page = await Api.repositoryResearchWorkspaces(
				project.repositoryOwner,
				project.repositoryName,
				controller.signal,
				includeArchived,
			);
			if (!currentResearchRequest(loads.current, id, controller)) return false;
			setResearch(current => ({
				...current,
				[id]: completeResearchLoad(current[id] ?? beginResearchLoad(), page, !replace),
			}));
			return true;
		} catch (error) {
			if (!currentResearchRequest(loads.current, id, controller)) return false;
			setResearch(current => ({
				...current,
				[id]: failResearchLoad(current[id] ?? beginResearchLoad(), error),
			}));
			return false;
		} finally {
			if (loads.current.get(id) === controller) loads.current.delete(id);
		}
	}, [includeArchived]);

	useEffect(() => {
		for (let controller of loads.current.values()) controller.abort();
		loads.current.clear();
		setResearch({});
	}, [includeArchived]);

	useEffect(() => {
		if (!navigation) return;
		let available = new Set(
			navigation.projects.filter(project => project.available)
				.map(project => project.repositoryId),
		);
		for (let [id, controller] of loads.current) {
			if (!available.has(id)) controller.abort();
		}
		setResearch(current => {
			let entries = Object.entries(current).filter(([id]) => available.has(id));
			return entries.length === Object.keys(current).length
				? current
				: Object.fromEntries(entries);
		});
		for (let project of navigation.projects) {
			let loadedDocuments = documents.find(entry =>
				entry.project.repositoryId === project.repositoryId
			)?.documents;
			if (
				project.available && !research[project.repositoryId]
				&& !loads.current.has(project.repositoryId)
				&& loadedDocuments
				&& (loadedDocuments.status !== "loading" || loadedDocuments.channels.length > 0)
			) {
				void load(project);
			}
		}
	}, [documents, load, navigation, research]);

	useEffect(() => () => {
		for (let controller of loads.current.values()) controller.abort();
		loads.current.clear();
		for (let timer of retryTimers.current.values()) clearTimeout(timer);
		retryTimers.current.clear();
	}, []);

	let upsertResearchWorkspace = useCallback((
		channel: Api.ResearchParentChannel,
		workspace: Research.WorkspaceSummary,
	) => {
		invalidations.current.set(workspace.id, workspace.revision);
		setResearch(current => upsertLoadedResearch(current, channel.repositoryId, channel, workspace));
	}, []);

	let refreshResearchWorkspace = useCallback((
		channel: Api.ResearchParentChannel,
		workspaceId: string,
		revision: number,
	) => {
		let seen = invalidations.current.get(workspaceId) ?? -1;
		if (revision <= seen) return;
		let project = projects.current.get(channel.repositoryId);
		if (!project?.available) return;
		let retry = (attempt: number) => {
			if (revision <= (invalidations.current.get(workspaceId) ?? -1)) return;
			clearTimeout(retryTimers.current.get(workspaceId));
			retryTimers.current.delete(workspaceId);
			void load(project, true).then(loaded => {
				if (loaded) {
					invalidations.current.set(workspaceId, revision);
					return;
				}
				if (attempt >= 4 || revision <= (invalidations.current.get(workspaceId) ?? -1)) return;
				let timer = setTimeout(() => retry(attempt + 1), Math.min(500 * 2 ** attempt, 8_000));
				retryTimers.current.set(workspaceId, timer);
			});
		};
		retry(0);
	}, [load]);
	let refreshResearchChannel = useCallback((channel: Api.ResearchParentChannel) => {
		let project = projects.current.get(channel.repositoryId);
		if (project?.available) void load(project, true);
	}, [load]);
	let removeResearchChannel = useCallback((channelId: string) => {
		for (let controller of loads.current.values()) controller.abort();
		loads.current.clear();
		setResearch(current => removeLoadedResearchChannel(current, channelId));
	}, []);

	let groups = useMemo(() => researchByChannel(research), [research]);
	return {
		groups,
		refreshResearchChannel,
		refreshResearchWorkspace,
		removeResearchChannel,
		research,
		upsertResearchWorkspace,
	};
}
