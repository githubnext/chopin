import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePhone } from "@chopin/editor/pointer";
import { parseChildDocumentPath, parseDocumentPath } from "@chopin/protocol/document-url";

import * as Api from "./api";
import { childCloseAction, childFocusTransition, childHistoryState } from "./child-history";
import { rememberOriginRect } from "./child-origin";
import { WorkspaceNotice } from "./workspace-notice";
import { NavigationShell } from "./navigation-shell";
import { PhoneDocumentSkeleton } from "./phone-skeleton";

import type { ReactNode } from "react";
import type { ResearchOpener } from "@chopin/editor";
import type { ChildFocusEvent, ChildFocusState, ChildFocusToken } from "./child-history";
import type { ParentFocusTarget } from "./document-workspace-host";
import type { DocumentRouteIdentitySource } from "./document-route-swap";
import type { WorkspacePresentation } from "./workspace-model";

// Document routes load their swap and host together, so neither waits on the other.
let DocumentRouteSwap = lazy(() => {
	void import("./document-workspace-host");
	return import("./document-route-view");
});
// Only a failed load shows it, so it stays out of the first JavaScript a reader downloads.
let Failure = lazy(() => import("./hosted-failure"));

export type HostedWorkspaceProps = {
	room: string;
	handle: string;
	label: string;
	slug: string;
	updatedAt: string;
	descriptionRevision: number;
	description?: string;
	repository: Api.Repository;
	canEdit: boolean;
	canManage: boolean;
	archivedAt?: string;
	agent?: boolean;
	userId: string;
	onMetadataChanged?: (
		metadata: Pick<
			Api.Channel,
			| "archivedAt"
			| "description"
			| "descriptionRevision"
			| "slug"
			| "title"
			| "updatedAt"
		>,
	) => void;
	presentation: WorkspacePresentation;
};

export type HostedRoute =
	| DocumentRouteIdentitySource
	| { page: "repositories" }
	| { page: "repository"; owner: string; repository: string }
	| { page: "missing" };

export type ChannelSource = Extract<DocumentRouteIdentitySource, { page: "channel" }>;

function decoded(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

export function hostedRoute(pathname: string): HostedRoute {
	if (pathname === "/" || pathname === "") return { page: "repositories" };
	let child = parseChildDocumentPath(pathname);
	if (child) return { page: "child", ...child };
	let document = parseDocumentPath(pathname);
	if (document?.slug) {
		return {
			page: "document",
			owner: document.owner,
			repository: document.repository,
			slug: document.slug,
		};
	}
	if (document) return { page: "repository", ...document };
	let repository = /^\/repositories\/([^/]+)\/([^/]+)\/?$/.exec(pathname);
	if (repository) {
		let owner = decoded(repository[1]!);
		let name = decoded(repository[2]!);
		if (owner && name) return { page: "repository", owner, repository: name };
	}
	let channel = /^\/channels\/([0-9a-f-]{36})\/?$/i.exec(pathname);
	if (channel) return { page: "channel", id: channel[1]!.toLowerCase() };
	return { page: "missing" };
}

export function retryableChannelFailure(error: unknown): boolean {
	return !(error instanceof Api.ApiError)
		|| error.status === 408
		|| error.status === 429
		|| error.status >= 500;
}

/** On a phone, a document's loading state is the workspace's own shape rather than a label. */
function Loading({ document, label = "Loading" }: { document?: boolean; label?: string }) {
	let phone = usePhone();
	if (document && phone) return <PhoneDocumentSkeleton />;
	return (
		<div
			className="hosted-loading flex h-full items-center justify-center bg-ground px-4 text-sm text-text-tertiary"
			data-hosted=""
			role="status"
		>
			{label}
		</div>
	);
}

export function HostedApp(
	{ agent, user }: { agent: boolean; user: Api.User },
) {
	let [route, setRoute] = useState(() => hostedRoute(location.pathname));
	let [navigationRevision, setNavigationRevision] = useState(0);
	let hostedRouteRef = useRef(route);
	hostedRouteRef.current = route;
	let childOpener = useRef<ResearchOpener | undefined>(undefined);
	// The root document can replace a research card's opener while the child's first commit lays
	// out, so the clicked element and its rect are kept from the click itself.
	let childOriginElement = useRef<HTMLElement | undefined>(undefined);
	let childFocus = useRef<ChildFocusState>({ generation: 0 });
	let childFocusFrame = useRef<number | undefined>(undefined);
	let cancelChildFocusFrame = useCallback(() => {
		if (childFocusFrame.current !== undefined) cancelAnimationFrame(childFocusFrame.current);
		childFocusFrame.current = undefined;
	}, []);
	let moveChildFocus = useCallback((event: ChildFocusEvent) => {
		let current = childFocus.current;
		let next = childFocusTransition(current, event);
		if (next !== current && !next.attempt) cancelChildFocusFrame();
		childFocus.current = next;
		return next;
	}, [cancelChildFocusFrame]);
	let childRouteChanged = useCallback((pathname: string) => {
		moveChildFocus({ type: "route", pathname });
	}, [moveChildFocus]);
	let navigate = useCallback((
		destination: string,
		options: { opener?: ResearchOpener; replace?: boolean } = {},
	) => {
		let target = new URL(destination, location.href);
		if (target.origin !== location.origin) {
			moveChildFocus({ type: "cancel" });
			location.assign(target.href);
			return;
		}
		let next = `${target.pathname}${target.search}${target.hash}`;
		let current = `${location.pathname}${location.search}${location.hash}`;
		if (next === current) return;
		setNavigationRevision(value => value + 1);
		childRouteChanged(target.pathname);
		let nextRoute = hostedRoute(target.pathname);
		if (options.replace) history.replaceState(history.state, "", next);
		else {
			let currentRoute = hostedRouteRef.current;
			let siblingChild = nextRoute.page === "child" && currentRoute.page === "child"
				&& nextRoute.owner.toLocaleLowerCase() === currentRoute.owner.toLocaleLowerCase()
				&& nextRoute.repository.toLocaleLowerCase()
					=== currentRoute.repository.toLocaleLowerCase()
				&& nextRoute.parentSlug === currentRoute.parentSlug;
			let inAppChild = nextRoute.page === "child" && currentRoute.page === "document"
				&& nextRoute.owner.toLocaleLowerCase() === currentRoute.owner.toLocaleLowerCase()
				&& nextRoute.repository.toLocaleLowerCase() === currentRoute.repository.toLocaleLowerCase()
				&& nextRoute.parentSlug === currentRoute.slug;
			if (siblingChild || inAppChild) {
				let active = document.activeElement;
				childOpener.current = options.opener
					?? { current: active instanceof HTMLElement ? active : null };
				childOriginElement.current = childOpener.current.current ?? undefined;
				rememberOriginRect(childOriginElement.current);
			}
			if (siblingChild) history.replaceState(history.state, "", next);
			else if (inAppChild) {
				history.pushState(
					childHistoryState(history.state, current),
					"",
					next,
				);
			} else history.pushState(null, "", next);
		}
		setRoute(nextRoute);
	}, [childRouteChanged, moveChildFocus]);
	let canonicalPath = useCallback((pathname: string) => {
		if (location.pathname === pathname) return;
		childRouteChanged(pathname);
		history.replaceState(
			history.state,
			"",
			`${pathname}${location.search}${location.hash}`,
		);
		setRoute(hostedRoute(pathname));
	}, [childRouteChanged]);
	let beginChildClosing = useCallback((parentId: string, parentPath: string) => {
		cancelChildFocusFrame();
		let current = childFocus.current;
		let next = moveChildFocus({
			type: "begin",
			opener: childOpener.current,
			parentId,
			parentPath,
		});
		let started = next !== current;
		if (started) {
			childOpener.current = undefined;
			childOriginElement.current = undefined;
		}
		return { started, token: { generation: next.generation, parentId } };
	}, [cancelChildFocusFrame, moveChildFocus]);
	let closeChild = useCallback((parentId: string, parentPath: string, opener?: ResearchOpener) => {
		// A provenance link returns focus to the parent's research card instead of the original opener.
		if (opener) childOpener.current = opener;
		let closing = beginChildClosing(parentId, parentPath);
		if (!closing.started) return;
		let action = childCloseAction(history.state, parentPath);
		if (action.type === "back") history.back();
		else navigate(action.destination, { replace: true });
	}, [beginChildClosing, navigate]);
	let childClosing = useCallback((parentId: string, parentPath: string): ChildFocusToken => {
		return beginChildClosing(parentId, parentPath).token;
	}, [beginChildClosing]);
	let restoreParentFocus = useCallback((token: ChildFocusToken, target: ParentFocusTarget) => {
		let current = childFocus.current;
		let next = childFocusTransition(current, { type: "restore", token });
		if (next === current || next.attempt?.phase !== "deferred") return;
		childFocus.current = next;
		let attempt = next.attempt;
		cancelChildFocusFrame();
		childFocusFrame.current = requestAnimationFrame(() => {
			childFocusFrame.current = undefined;
			let latest = childFocus.current.attempt;
			if (
				latest?.generation !== attempt.generation
				|| latest.parentId !== attempt.parentId
				|| latest.phase !== "deferred"
				|| location.pathname !== attempt.parentPath
			) return;
			let focus = target(attempt);
			moveChildFocus(focus ? { type: "finish", token } : { type: "cancel" });
			focus?.();
		});
	}, [cancelChildFocusFrame, moveChildFocus]);
	let childOrigin = useCallback(
		() =>
			childOpener.current?.current ?? childOriginElement.current
				?? childFocus.current.attempt?.opener?.current ?? undefined,
		[],
	);

	useEffect(() => {
		let changed = () => {
			setNavigationRevision(value => value + 1);
			childRouteChanged(location.pathname);
			setRoute(hostedRoute(location.pathname));
		};
		window.addEventListener("popstate", changed);
		return () => {
			window.removeEventListener("popstate", changed);
			moveChildFocus({ type: "cancel" });
			cancelChildFocusFrame();
		};
	}, [cancelChildFocusFrame, childRouteChanged, moveChildFocus]);

	let workspace: ReactNode;
	switch (route.page) {
		case "missing":
			workspace = (
				<WorkspaceNotice
					actions={<a className="btn btn-md btn-primary" href="/">Go to Chopin</a>}
					body="This page doesn't exist."
					title="Page not found"
				/>
			);
			break;
		case "repositories":
		case "repository":
			break;
		case "document":
		case "child":
		case "channel":
			workspace = (
				<Suspense fallback={<Loading document label="Opening document…" />}>
					<DocumentRouteSwap
						agent={agent}
						childOrigin={childOrigin}
						onCanonicalPath={canonicalPath}
						onChildClose={closeChild}
						onChildOpen={navigate}
						onChildClosing={childClosing}
						onParentRestored={restoreParentFocus}
						route={route}
						user={user}
					/>
				</Suspense>
			);
			break;
	}
	return (
		<NavigationShell
			navigate={navigate}
			navigationRevision={navigationRevision}
			route={route}
			user={user}
		>
			{workspace}
		</NavigationShell>
	);
}

export { Failure as HostedFailure, Loading as HostedLoading };
