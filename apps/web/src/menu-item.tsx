import type { KeyboardEventHandler, MouseEventHandler, ReactNode, Ref } from "react";

type MenuItemProps =
	& {
		children: ReactNode;
		density?: "compact" | "normal";
		onClick?: MouseEventHandler<HTMLElement>;
		onKeyDown?: KeyboardEventHandler<HTMLElement>;
		tone?: "normal" | "destructive";
	}
	& (
		| {
			disabled?: never;
			href: string;
			ref?: Ref<HTMLAnchorElement>;
			rel?: string;
			target?: string;
		}
		| {
			disabled?: boolean;
			href?: never;
			ref?: Ref<HTMLButtonElement>;
			rel?: never;
			target?: never;
		}
	);

export function MenuItem(props: MenuItemProps) {
	if (props.href !== undefined) {
		return (
			<a
				className="app-menu-item"
				data-density={props.density ?? "normal"}
				data-tone={props.tone ?? "normal"}
				href={props.href}
				onClick={props.onClick}
				onKeyDown={props.onKeyDown}
				ref={props.ref}
				rel={props.rel}
				role="menuitem"
				target={props.target}
			>
				{props.children}
			</a>
		);
	}
	return (
		<button
			className="app-menu-item"
			data-density={props.density ?? "normal"}
			data-tone={props.tone ?? "normal"}
			disabled={props.disabled}
			onClick={props.onClick}
			onKeyDown={props.onKeyDown}
			ref={props.ref}
			role="menuitem"
			type="button"
		>
			{props.children}
		</button>
	);
}

export function MenuSeparator() {
	return <div className="app-menu-separator" role="separator" />;
}
