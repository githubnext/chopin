import { createContext, useContext } from "react";
import { ChopinMark } from "@chopin/editor";

import type { PlannerPresence } from "./planner-status";

import "./presence-dot.css";

/** chopin's presence for Chat's rows to draw on its avatar, where its machine is told at all. */
export const PlannerPresenceContext = createContext<PlannerPresence | undefined>(undefined);

/**
 * chopin's avatar in a Chat row, with its presence on the corner as Slack draws an app's. The dot
 * is decoration: the machine button's name and the `@` menu's row say the state in words.
 */
export function AgentAvatar() {
	let presence = useContext(PlannerPresenceContext);
	if (!presence) return <ChopinMark circle />;
	return (
		<span className="presence-host" data-presence-host="">
			<ChopinMark circle />
			<span aria-hidden="true" className="presence-dot" data-presence={presence} />
		</span>
	);
}
