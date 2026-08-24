import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { documentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import {
	anchoredChildPaths,
	AnchoredChildSurface,
	childPresentation,
	rebaseChildHistoryState,
} from "./anchored-child-surface";
import { rememberChannel } from "./channel-recovery";

import type { ComponentType } from "react";
import type { ChildPresentation } from "./anchored-child-surface";
import type { HostedRoute } from "./hosted";
import type { WorkspaceSurface } from "./workspace-model";

let RoomWorkspace = lazy(() =>
	import("./room-workspace").then(module => ({ default: module.RoomWorkspace }))
);

type DocumentRoute = Extract<HostedRoute, { page: "document" | "child" }>;
type Metadata = Pick<
	Api.Channel,
	| "archivedAt"
	| "description"
	| "descriptionRevision"
	| "slug"
	| "title"
	| "updatedAt"
>;

function workspaceProps(
	detail: Api.ChannelDetail,
	agent: boolean,
	user: Api.User,
	surface: WorkspaceSurface,
	onMetadataChanged: (metadata: Metadata) => void,
) {
	let channel = detail.channel;
	return {
		agent,
		archivedAt: channel.archivedAt,
		canEdit: !channel.archivedAt && (detail.canEdit || detail.canManage),
		canManage: detail.canManage,
		description: channel.description,
		descriptionRevision: channel.descriptionRevision,
		handle: user.login,
		label: channel.title,
		onMetadataChanged,
		repository: detail.repository,
		room: channel.id,
		slug: channel.slug,
		surface,
		updatedAt: channel.updatedAt,
		userId: user.id,
	};
}

export default function DocumentWorkspaceHost(
	{
		agent,
		Failure,
		Loading,
		loadDocument,
		onCanonicalPath,
		onChildClose,
		onParentRestored,
		onReady,
		retryable,
		route,
		user,
	}: {
		agent: boolean;
		Failure: ComponentType<{ error: unknown; onRetry?: () => void }>;
		Loading: ComponentType<{ label?: string }>;
		loadDocument: (
			address: { owner: string; repository: string; slug: string; parentSlug?: string },
			signal: AbortSignal,
		) => Promise<{ detail: Api.ChannelDetail; parent?: Api.ChannelDetail; pathname: string }>;
		onCanonicalPath: (pathname: string) => void;
		onChildClose: (parentPath: string) => void;
		onParentRestored: (parentId: string) => void;
		onReady: (pathname?: string, channel?: Api.Channel) => void;
		retryable: (error: unknown) => boolean;
		route: DocumentRoute;
		user: Api.User;
	},
) {
	let [loaded, setLoaded] = useState<{
		child?: Api.ChannelDetail;
		parent: Api.ChannelDetail;
	}>();
	let loadedRef = useRef(loaded);
	loadedRef.current = loaded;
	let routeRef = useRef(route);
	routeRef.current = route;
	let [error, setError] = useState<unknown>();
	let [retry, setRetry] = useState(0);
	let [presentation, setPresentation] = useState<ChildPresentation>("closed");
	let parentScrollTop = useRef<number | undefined>(undefined);
	let parentSlugs = useRef(new Set<string>());

	useEffect(() => {
		let active = true;
		let controller = new AbortController();
		setError(undefined);
		let current = loadedRef.current;
		if (route.page === "child" && current && !current.child) {
			let scroller = document.querySelector<HTMLElement>(
				`[data-workspace-room="${CSS.escape(current.parent.channel.id)}"] [data-plan-scroll]`,
			);
			if (scroller) parentScrollTop.current = scroller.scrollTop;
		}
		let address = {
			owner: route.owner,
			repository: route.repository,
			slug: route.page === "child" ? route.childSlug : route.slug,
			...(route.page === "child" ? { parentSlug: route.parentSlug } : {}),
		};
		void loadDocument(address, controller.signal).then(prepared => {
			if (!active) return;
			let parent = prepared.parent ?? prepared.detail;
			let child = prepared.parent ? prepared.detail : undefined;
			rememberChannel(user.id, parent.channel, parent.repository);
			if (child) rememberChannel(user.id, child.channel, child.repository);
			let previous = loadedRef.current;
			let sameParent = previous?.parent.channel.id === parent.channel.id;
			if (!sameParent) parentSlugs.current.clear();
			parentSlugs.current.add(parent.channel.slug);
			parentSlugs.current.add(route.page === "child" ? route.parentSlug : route.slug);
			let updated = child
				? { child, parent }
				: sameParent && previous?.child
				? { ...previous, parent }
				: { parent };
			loadedRef.current = updated;
			setLoaded(updated);
			if (child) {
				setPresentation(current => childPresentation(current, "child", true));
			} else if (previous?.child) {
				setPresentation(current => childPresentation(current, "parent", sameParent));
			}
			onReady(prepared.pathname, (child ?? parent).channel);
		}, reason => {
			if (active) {
				setError(reason);
				onReady();
			}
		});
		return () => {
			active = false;
			controller.abort();
		};
	}, [loadDocument, onReady, retry, route, user.id]);

	useLayoutEffect(() => {
		let current = loadedRef.current;
		if (!current || parentScrollTop.current === undefined) return;
		let scroller = document.querySelector<HTMLElement>(
			`[data-workspace-room="${CSS.escape(current.parent.channel.id)}"] [data-plan-scroll]`,
		);
		if (scroller) scroller.scrollTop = parentScrollTop.current;
		if (presentation === "closed") parentScrollTop.current = undefined;
	}, [loaded, presentation]);

	useEffect(() => {
		let current = loadedRef.current;
		if (!current?.child) return;
		let sameParent = route.owner.toLocaleLowerCase()
				=== current.parent.repository.owner.toLocaleLowerCase()
			&& route.repository.toLocaleLowerCase()
				=== current.parent.repository.name.toLocaleLowerCase()
			&& parentSlugs.current.has(route.page === "child" ? route.parentSlug : route.slug);
		setPresentation(value =>
			childPresentation(value, route.page === "child" ? "child" : "parent", sameParent)
		);
		if (sameParent) {
			return;
		}
		let updated = { parent: current.parent };
		loadedRef.current = updated;
		setLoaded(updated);
	}, [route]);

	useEffect(() => {
		if (presentation !== "closing") return;
		let timer = window.setTimeout(() => {
			setPresentation("closed");
			let current = loadedRef.current;
			let parentId = current?.parent.channel.id;
			if (current) {
				let updated = { parent: current.parent };
				loadedRef.current = updated;
				setLoaded(updated);
			}
			if (parentId) onParentRestored(parentId);
		}, 190);
		return () => window.clearTimeout(timer);
	}, [onParentRestored, presentation]);

	useEffect(() => {
		if (presentation !== "open") return;
		let closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			event.preventDefault();
			let current = loadedRef.current;
			if (current?.child) {
				onChildClose(documentPath(
					current.parent.repository.owner,
					current.parent.repository.name,
					current.parent.channel.slug,
				));
			}
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onChildClose, presentation]);

	let metadataChanged = useCallback((kind: "parent" | "child", metadata: Metadata) => {
		let current = loadedRef.current;
		if (!current) return;
		let target = kind === "parent" ? current.parent : current.child;
		if (!target) return;
		let next = { ...target, channel: { ...target.channel, ...metadata } };
		let updated = kind === "parent" ? { ...current, parent: next } : { ...current, child: next };
		if (kind === "parent") parentSlugs.current.add(metadata.slug);
		loadedRef.current = updated;
		setLoaded(updated);
		let paths = anchoredChildPaths(
			{
				owner: updated.parent.repository.owner,
				repository: updated.parent.repository.name,
				slug: updated.parent.channel.slug,
			},
			updated.child?.channel.slug,
		);
		let pathname = routeRef.current.page === "child" && updated.child
			? paths.child!
			: paths.parent;
		if (kind === "parent" && routeRef.current.page === "child") {
			history.replaceState(rebaseChildHistoryState(history.state, paths.parent), "");
		}
		onCanonicalPath(pathname);
	}, [onCanonicalPath]);
	let parentMetadataChanged = useCallback(
		(metadata: Metadata) => metadataChanged("parent", metadata),
		[metadataChanged],
	);
	let childMetadataChanged = useCallback(
		(metadata: Metadata) => metadataChanged("child", metadata),
		[metadataChanged],
	);

	if (error) {
		return (
			<Failure
				error={error}
				onRetry={retryable(error)
					? () => {
						setError(undefined);
						setRetry(value => value + 1);
					}
					: undefined}
			/>
		);
	}
	if (!loaded) return <Loading label="Opening document..." />;

	let parentPath = anchoredChildPaths(
		{
			owner: loaded.parent.repository.owner,
			repository: loaded.parent.repository.name,
			slug: loaded.parent.channel.slug,
		},
		loaded.child?.channel.slug,
	).parent;
	let parent = (
		<Suspense fallback={<Loading label="Opening parent document..." />}>
			<RoomWorkspace
				{...workspaceProps(loaded.parent, agent, user, "document", parentMetadataChanged)}
				key={loaded.parent.channel.id}
			/>
		</Suspense>
	);
	let child = loaded.child
		? (
			<Suspense fallback={<Loading label="Opening child document..." />}>
				<RoomWorkspace
					{...workspaceProps(loaded.child, agent, user, "child", childMetadataChanged)}
					key={loaded.child.channel.id}
				/>
			</Suspense>
		)
		: undefined;
	return (
		<AnchoredChildSurface
			child={child}
			childLabel={loaded.child?.channel.title ?? ""}
			onClose={() => onChildClose(parentPath)}
			parent={parent}
			parentLabel={loaded.parent.channel.title}
			presentation={presentation}
			key={loaded.parent.channel.id}
		/>
	);
}
