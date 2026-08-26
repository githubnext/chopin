import type { ReactNode } from "react";

export function TerminalAlert(
	{ children, className = "" }: { children: ReactNode; className?: string },
) {
	return (
		<div
			className={`motion-feedback ${className}`.trim()}
			data-motion-feedback="alert"
			role="alert"
		>
			{children}
		</div>
	);
}
