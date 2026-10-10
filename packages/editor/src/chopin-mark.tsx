import { ChopinIcon } from "@chopin/icons";

/** Chopin's mark, as Chat shows the Planner and comments will show its notes. */

export function ChopinMark({ circle = false }: { circle?: boolean }) {
	return (
		<span
			className="agent-mark"
			data-circle={circle || undefined}
			role="img"
			aria-label="Chopin"
		>
			<ChopinIcon />
		</span>
	);
}
