import { ChopinIcon } from "@chopin/icons";

export function ChopinMark({ circle = false }: { circle?: boolean }) {
	return (
		<span
			className="chat-agent-mark"
			data-circle={circle || undefined}
			role="img"
			aria-label="Chopin"
		>
			<ChopinIcon />
		</span>
	);
}
