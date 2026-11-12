import { ChopinIcon } from "@chopin/icons";

import { PLANNER_NAME } from "./people";

/** Chopin's mark, as Chat shows the Planner and comments will show its notes. */

export function ChopinMark({ circle = false }: { circle?: boolean }) {
	return (
		<span
			className="agent-mark"
			data-circle={circle || undefined}
			role="img"
			aria-label={PLANNER_NAME}
		>
			<ChopinIcon />
		</span>
	);
}
