import {
	ContrastIcon,
	KeyboardIcon,
	LockIcon,
	MonitorIcon,
	MoonIcon,
	SignInIcon,
	SunIcon,
} from "@chopin/icons";
import { Face } from "@chopin/editor/face";
import { useId, useSyncExternalStore } from "react";

import { MenuItem, MenuSeparator } from "./menu-item";
import {
	chooseTheme,
	currentThemeChoice,
	subscribeThemeChoice,
	THEME_CHOICES,
} from "./theme-choice";

import type * as Api from "./api";
import type { ThemeChoice } from "./theme-choice";
import type { KeyboardEvent, Ref } from "react";

export type AccountMenuState = {
	className: string;
	closing: boolean;
	onDismiss: () => void;
	onShortcuts: () => void;
	onSignOut: () => void;
};

export function menuItemTarget(key: string, current: number, count: number): number {
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return (current + (key === "ArrowDown" ? 1 : -1) + count) % count;
}

const THEME_NAMES: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "System" };
const THEME_GLYPHS = { light: SunIcon, dark: MoonIcon, system: MonitorIcon };

/**
 * The menu's stops, top to bottom: each item, and the theme row once, at its chosen segment. A
 * segment that has the focus stands for its row.
 */
function menuStops(menu: HTMLElement, focused: Element | null) {
	let stops = [...menu.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio]")]
		.filter(item =>
			item.getAttribute("role") === "menuitem" || item.getAttribute("aria-checked") === "true"
		);
	let current = stops.findIndex(item =>
		item === focused
		|| (item.getAttribute("role") === "menuitemradio" && item.parentElement?.contains(focused))
	);
	return { stops, current };
}

/**
 * Light, Dark and System, as one row of the menu. Arrow keys move along it without leaving the
 * menu, and choosing keeps the menu open so the change is seen behind it.
 */
function ThemeRow() {
	let label = useId();
	let chosen = useSyncExternalStore(subscribeThemeChoice, currentThemeChoice, () => "system");
	let onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		let segments = [
			...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitemradio]"),
		];
		let at = segments.indexOf(document.activeElement as HTMLElement);
		let step = event.key === "ArrowRight" ? 1 : -1;
		segments[(at + step + segments.length) % segments.length]?.focus();
	};
	return (
		<div aria-labelledby={label} className="account-theme" role="group">
			<span className="account-theme-label" id={label}>
				<ContrastIcon aria-hidden="true" size={16} />
				Theme
			</span>
			<div className="account-theme-segments" onKeyDown={onKeyDown}>
				{THEME_CHOICES.map(choice => {
					let Glyph = THEME_GLYPHS[choice];
					return (
						<button
							aria-checked={choice === chosen}
							aria-label={THEME_NAMES[choice]}
							className="account-theme-segment"
							key={choice}
							onClick={() => chooseTheme(choice)}
							role="menuitemradio"
							type="button"
						>
							<Glyph aria-hidden="true" size={14} />
						</button>
					);
				})}
			</div>
		</div>
	);
}

export function AccountMenu({ id, menu }: { id?: string; menu: AccountMenuState }) {
	return (
		<div
			aria-hidden={menu.closing ? "true" : undefined}
			className={`navigation-account-menu motion-dropdown ${menu.className}`}
			id={id}
			inert={menu.closing}
			onKeyDown={event => {
				if (event.key === "Tab") return menu.onDismiss();
				if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				let { current, stops } = menuStops(event.currentTarget, document.activeElement);
				stops[menuItemTarget(event.key, current, stops.length)]?.focus();
			}}
			role="menu"
		>
			<MenuItem density="compact" href="/auth/github/install" rel="noopener" target="_blank">
				<LockIcon aria-hidden="true" size={16} />
				Manage repository access
			</MenuItem>
			<MenuItem
				density="compact"
				onClick={menu.onShortcuts}
			>
				<KeyboardIcon aria-hidden="true" size={16} />Keyboard shortcuts
			</MenuItem>
			<ThemeRow />
			<MenuSeparator />
			<MenuItem density="compact" onClick={menu.onSignOut}>
				<SignInIcon aria-hidden="true" className="-scale-x-100" size={16} />
				Sign out
			</MenuItem>
		</div>
	);
}

/** The sidebar's account trigger and, while it is open, its menu. */
export function SidebarAccount(
	{ menu, menuId, onAccount, open, triggerRef, user, wrapRef }: {
		menu?: false | AccountMenuState;
		menuId?: string;
		onAccount: () => void;
		open?: boolean;
		triggerRef?: Ref<HTMLButtonElement>;
		user: Api.User;
		wrapRef?: Ref<HTMLDivElement>;
	},
) {
	return (
		<div className="project-sidebar-account-wrap" ref={wrapRef}>
			<button
				aria-controls={menu ? menuId : undefined}
				aria-haspopup="menu"
				ref={triggerRef}
				className="project-sidebar-account"
				aria-expanded={open ?? !!menu}
				onClick={onAccount}
				type="button"
			>
				<Face decorative handle={user.login} size={20} titled={false} />
				<span className="truncate">{user.login}</span>
			</button>
			{menu && <AccountMenu id={menuId} menu={menu} />}
		</div>
	);
}
