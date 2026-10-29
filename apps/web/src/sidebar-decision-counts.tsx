import { useCallback, useEffect, useMemo, useRef } from "react";

import { decisionWatchPlan, fallbackRefreshBatch } from "./sidebar-decision-plan";
import { useSidebarDecisions } from "./use-sidebar-decisions";

import type { Sidebar } from "@chopin/protocol";
import type { RefObject } from "react";
import type * as Api from "./api";
import type { ProjectDocuments } from "./document-actions";

const UNWATCHED_REFRESH_MS = 60_000;
/** Changes to one repository's documents within this long are read once, after the last. */
export const CATALOGUE_SETTLE_MS = 250;

export default function SidebarDecisionCounts({
	archived,
	onCounts,
	onSnapshot,
	priorityRepositoryId,
	projects,
	refreshProject,
	resync,
}: {
	archived: boolean;
	onCounts: (counts: Sidebar.Decisions) => void;
	onSnapshot: (snapshot: Sidebar.Snapshot) => void;
	priorityRepositoryId?: string;
	projects: ProjectDocuments[];
	refreshProject: (project: Api.NavigationProject) => void;
	resync: RefObject<(repositoryId: string) => void>;
}) {
	let decisionWatch = useMemo(
		() =>
			archived ? { watched: [], unwatched: [] } : decisionWatchPlan(projects, priorityRepositoryId),
		[archived, priorityRepositoryId, projects],
	);
	let latestProjects = useRef(projects);
	latestProjects.current = projects;
	let catalogueTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(() => {
		let timers = catalogueTimers.current;
		return () => {
			for (let timer of timers.values()) clearTimeout(timer);
			timers.clear();
		};
	}, []);
	/** Someone changed a shown repository's documents: read them again, once a burst settles. */
	let onCatalogue = useCallback((change: Sidebar.Catalogue) => {
		let timers = catalogueTimers.current;
		clearTimeout(timers.get(change.repositoryId));
		timers.set(
			change.repositoryId,
			setTimeout(() => {
				timers.delete(change.repositoryId);
				let shown = latestProjects.current.find(value =>
					value.project.repositoryId === change.repositoryId
				);
				if (shown) refreshProject(shown.project);
			}, CATALOGUE_SETTLE_MS),
		);
	}, [refreshProject]);
	let resyncDecisions = useSidebarDecisions(decisionWatch.watched, {
		onCounts,
		onSnapshot,
		onCatalogue,
	});
	useEffect(() => {
		resync.current = resyncDecisions;
		return () => {
			resync.current = () => {};
		};
	}, [resync, resyncDecisions]);
	let unwatchedProjects = useRef(decisionWatch.unwatched);
	unwatchedProjects.current = decisionWatch.unwatched;
	let fallbackAfter = useRef<string | undefined>(undefined);
	let fallbackRefreshedAt = useRef(0);
	useEffect(() => {
		let refreshUnwatched = () => {
			if (document.visibilityState !== "visible") return;
			let now = Date.now();
			if (now - fallbackRefreshedAt.current < UNWATCHED_REFRESH_MS / 2) return;
			let batch = fallbackRefreshBatch(unwatchedProjects.current, fallbackAfter.current);
			if (batch.length === 0) return;
			fallbackRefreshedAt.current = now;
			fallbackAfter.current = batch.at(-1)!.repositoryId;
			for (let project of batch) refreshProject(project);
		};
		let interval = setInterval(refreshUnwatched, UNWATCHED_REFRESH_MS);
		window.addEventListener("focus", refreshUnwatched);
		document.addEventListener("visibilitychange", refreshUnwatched);
		return () => {
			clearInterval(interval);
			window.removeEventListener("focus", refreshUnwatched);
			document.removeEventListener("visibilitychange", refreshUnwatched);
		};
	}, [refreshProject]);
	return null;
}
