import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { Face } from "@chopin/editor/face";

import type { DemoActor } from "./active-actor";

/** Names the persona this tab acts as, so it is never mistaken for the presenter's tab. */
export function CollaboratorBadge({ actor }: { actor: DemoActor }) {
	return (
		<div
			aria-label={`Acting as ${actor.name}, a demo collaborator`}
			className="pointer-events-none fixed bottom-2 left-2 z-50 flex items-center gap-1.5 rounded-full bg-page py-0.5 pr-2 pl-0.5 text-2xs text-text-secondary ring-1 ring-ground"
			role="status"
		>
			<Face decorative handle={actor.id} size={16} textSize="2xs" titled={false} />
			<span>{actor.name}</span>
			<span className="text-text-tertiary">collaborator</span>
		</div>
	);
}

let badge: Root | undefined;

/** A separate root keeps the badge, and the editor's face, out of the initial bundle. */
export function showCollaboratorBadge(actor: DemoActor): void {
	if (!badge) {
		let host = document.createElement("div");
		document.body.append(host);
		badge = createRoot(host);
	}
	badge.render(<CollaboratorBadge actor={actor} />);
}
