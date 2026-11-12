import "./menu-switch.css";

import type { ReactNode } from "react";

/**
 * A menu row that turns a setting on and off without closing the menu, so the change is seen
 * behind it: a `menuitemcheckbox` whose switch at the row's end shows its state.
 */
export function MenuSwitchItem(
	{ checked, children, onChange }: {
		checked: boolean;
		children: ReactNode;
		onChange: (checked: boolean) => void;
	},
) {
	return (
		<button
			aria-checked={checked}
			className="app-menu-item app-menu-switch-item"
			data-density="normal"
			data-tone="normal"
			onClick={() => onChange(!checked)}
			role="menuitemcheckbox"
			type="button"
		>
			{children}
			<span aria-hidden="true" className="app-menu-switch" />
		</button>
	);
}
