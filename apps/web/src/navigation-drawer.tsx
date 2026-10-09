import { NavigationFocusScope } from "./navigation-focus";

import type { ReactNode } from "react";
import type { TransitionPresence } from "@chopin/editor/transition-presence";

export function NavigationDrawer(
	{
		children,
		motion,
		onDismiss,
	}: {
		children: ReactNode;
		motion: Exclude<TransitionPresence<boolean>, { phase: "closed" }>;
		onDismiss: () => void;
	},
) {
	let active = motion.phase !== "closing";
	return (
		<div
			aria-hidden={active ? undefined : "true"}
			className={`navigation-drawer motion-drawer ${motion.className}`}
			inert={!active}
			role="presentation"
		>
			<button
				aria-label="Close Projects sidebar"
				className="navigation-drawer-backdrop"
				data-press="none"
				onClick={onDismiss}
				type="button"
			/>
			<NavigationFocusScope active={active} onDismiss={onDismiss}>
				<div
					aria-label="Projects"
					aria-modal="true"
					className="project-sidebar-frame"
					role="dialog"
					tabIndex={-1}
				>
					{children}
				</div>
			</NavigationFocusScope>
		</div>
	);
}
