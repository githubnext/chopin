import { childDocumentPath, documentPath } from "@chopin/protocol/document-url";

import type { ReactNode } from "react";

export type ChildPresentation = "closed" | "open" | "closing";

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

export function childHistoryState(state: unknown, parent: string): Record<string, unknown> {
	return {
		...(typeof state === "object" && state !== null ? state : {}),
		chopinChildParent: parent,
	};
}

export function childCloseAction(
	state: unknown,
	parent: string,
): { type: "back" } | { type: "replace"; destination: string } {
	if (
		typeof state === "object" && state !== null
		&& "chopinChildParent" in state
		&& typeof state.chopinChildParent === "string"
	) {
		let markedParent = new URL(state.chopinChildParent, "http://chopin.local");
		if (markedParent.pathname === parent) return { type: "back" };
	}
	return { type: "replace", destination: parent };
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

export function childPresentation(
	current: ChildPresentation,
	route: "parent" | "child",
	sameParent: boolean,
): ChildPresentation {
	if (route === "child") return sameParent ? "open" : "closed";
	if (current !== "closed" && sameParent) return "closing";
	return "closed";
}

export function AnchoredChildSurface(
	{
		child,
		childLabel,
		onClose,
		parent,
		parentLabel,
		presentation,
	}: {
		child?: ReactNode;
		childLabel: string;
		onClose: () => void;
		parent: ReactNode;
		parentLabel: string;
		presentation: ChildPresentation;
	},
) {
	let childVisible = presentation !== "closed";
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
			>
				{parent}
			</div>
			{childVisible && (
				<section
					aria-label={`Child document: ${childLabel}`}
					className="anchored-child-surface"
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
