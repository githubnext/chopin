import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";
import { useLayoutEffect, useRef } from "react";

export { childCloseAction, childHistoryState } from "./child-history";
export { childPresentation } from "./document-workspace-state";

import type { ReactNode, Ref } from "react";
import type { ChildPresentation } from "./document-workspace-state";

export type { ChildPresentation } from "./document-workspace-state";

export type ParentDocumentAddress = {
	owner: string;
	repository: string;
	slug: string;
};

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
		onClose,
		parent,
		parentLabel,
		parentRef,
		presentation,
	}: {
		child?: ReactNode;
		childLabel: string;
		focusKey?: string;
		onClose: () => void;
		parent: ReactNode;
		parentLabel: string;
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
			<div
				aria-hidden={childVisible || undefined}
				className="anchored-child-parent"
				inert={childVisible}
				ref={parentRef}
			>
				{parent}
			</div>
			{childVisible && (
				<section
					aria-label={`Child document: ${childLabel}`}
					className="anchored-child-surface"
					ref={surface}
					tabIndex={-1}
				>
					<button
						aria-label={`Back to ${parentLabel}`}
						className="anchored-child-back btn btn-icon btn-ghost"
						onClick={onClose}
						title={`Back to ${parentLabel}`}
						type="button"
					>
						<span aria-hidden="true">←</span>
					</button>
					{child}
				</section>
			)}
		</div>
	);
}
