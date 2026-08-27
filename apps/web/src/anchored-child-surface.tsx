import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { useLayoutEffect, useRef } from "react";

export { childCloseAction, childHistoryState } from "./child-history";
export { childPresentation } from "./document-workspace-state";

import type { ReactNode, Ref } from "react";
import type { ChildPresentation } from "./document-workspace-state";
import type { ResearchOpener } from "@chopin/editor";

export type { ChildPresentation } from "./document-workspace-state";

export type ParentDocumentAddress = {
	owner: string;
	repository: string;
	slug: string;
};

export type ChildFocusToken = { generation: number; parentId: string };

export type ChildFocusAttempt = ChildFocusToken & {
	opener?: ResearchOpener;
	parentPath: string;
	phase: "closing" | "deferred";
};

export type ChildFocusState = {
	generation: number;
	attempt?: ChildFocusAttempt;
};

export type ChildFocusEvent =
	| {
		type: "begin";
		opener?: ResearchOpener;
		parentId: string;
		parentPath: string;
	}
	| { type: "route"; pathname: string }
	| { type: "restore" | "finish"; token: ChildFocusToken }
	| { type: "cancel" };

export function childFocusTransition(
	state: ChildFocusState,
	event: ChildFocusEvent,
): ChildFocusState {
	if (event.type === "begin") {
		if (
			state.attempt?.phase === "closing"
			&& state.attempt.parentId === event.parentId
			&& state.attempt.parentPath === event.parentPath
		) return state;
		let generation = state.generation + 1;
		return {
			generation,
			attempt: {
				generation,
				opener: event.opener,
				parentId: event.parentId,
				parentPath: event.parentPath,
				phase: "closing",
			},
		};
	}
	let attempt = state.attempt;
	if (!attempt) return state;
	if (event.type === "route") {
		return event.pathname === attempt.parentPath
			? state
			: { generation: state.generation + 1 };
	}
	if (event.type === "cancel") return { generation: state.generation + 1 };
	if (
		event.token.generation !== attempt.generation
		|| event.token.parentId !== attempt.parentId
	) return state;
	if (event.type === "finish") return { generation: state.generation };
	if (attempt.phase === "deferred") return state;
	return { ...state, attempt: { ...attempt, phase: "deferred" } };
}

export function anchoredChildPaths(parent: ParentDocumentAddress, childSlug?: string) {
	return {
		child: childSlug
			? childDocumentPath(parent.owner, parent.repository, parent.slug, childSlug)
			: undefined,
		parent: documentPath(parent.owner, parent.repository, parent.slug),
	};
}

export function rebaseChildHistoryState(
	state: unknown,
	parent: string,
): unknown {
	if (
		typeof state !== "object" || state === null
		|| !("chopinChildParent" in state)
		|| typeof state.chopinChildParent !== "string"
	) return state;
	let previous = new URL(state.chopinChildParent, "http://chopin.local");
	return {
		...state,
		chopinChildParent: `${parent}${previous.search}${previous.hash}`,
	};
}

export function AnchoredChildSurface(
	{
		child,
		childLabel,
		focusKey,
		onBackdropClick,
		parent,
		parentRef,
		presentation,
	}: {
		child?: ReactNode;
		childLabel: string;
		focusKey?: string;
		onBackdropClick?: () => void;
		parent: ReactNode;
		parentRef?: Ref<HTMLDivElement>;
		presentation: ChildPresentation;
	},
) {
	let childVisible = presentation !== "closed";
	let surface = useRef<HTMLElement>(null);
	let focused = useRef<string | undefined>(undefined);
	useLayoutEffect(() => {
		if (presentation !== "open") {
			if (presentation === "closed") focused.current = undefined;
			return;
		}
		if (!focusKey || focused.current === focusKey) return;
		focused.current = focusKey;
		surface.current?.focus({ preventScroll: true });
	}, [focusKey, presentation]);
	return (
		<div
			className="anchored-child-host"
			data-child-presentation={presentation}
			data-child-visible={childVisible || undefined}
		>
			<div className="anchored-child-parent" ref={parentRef}>
				{parent}
			</div>
			{presentation === "open" && onBackdropClick && (
				<div
					aria-hidden="true"
					className="anchored-child-backdrop"
					data-child-backdrop
					onClick={onBackdropClick}
				/>
			)}
			{childVisible && (
				<section
					aria-label={`Child document: ${childLabel}`}
					className="anchored-child-surface"
					ref={surface}
					tabIndex={-1}
				>
					{child}
				</section>
			)}
		</div>
	);
}
