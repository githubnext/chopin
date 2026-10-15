import { KeyboardIcon, LockIcon, SignInIcon } from "@chopin/icons";
import { Face } from "@chopin/editor/face";

import { MenuItem, MenuSeparator } from "./menu-item";

import type * as Api from "./api";
import type { Ref } from "react";

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
				let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
				items[
					menuItemTarget(
						event.key,
						items.indexOf(document.activeElement as HTMLElement),
						items.length,
					)
				]
					?.focus();
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
