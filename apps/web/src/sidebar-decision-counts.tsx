import { useEffect, useMemo, useRef } from "react";

import { decisionWatchPlan, fallbackRefreshBatch } from "./sidebar-decision-plan";
import { useSidebarDecisions } from "./use-sidebar-decisions";

import type { Sidebar } from "@chopin/protocol";
import type { RefObject } from "react";
import type * as Api from "./api";
import type { ProjectDocuments } from "./document-actions";

const UNWATCHED_REFRESH_MS = 60_000;

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
	let resyncDecisions = useSidebarDecisions(decisionWatch.watched, { onCounts, onSnapshot });
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
