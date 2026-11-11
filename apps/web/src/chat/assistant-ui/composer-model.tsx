/**
 * The `/` and `@` menus' elements, adapted from assistant-ui's Composer (MIT, Copyright (c) 2026
 * AgentbaseAI Inc.): `ComposerMenu` and `ComposerMenuItem`, from the registry item `elements-composer` as served on 2026-11-10
 * (repository `main` at f92028b466cba721846de6851e4dddb6c04ecfad). See THIRD_PARTY_NOTICES.md.
 *
 * The standalone lane: every element is driven by props and callbacks and none needs
 * assistant-ui's runtime. Restyled to Chopin's tokens, menu geometry and icons
 * (`composer-model.css`). Each takes the props it needs by name and picks its look from a finite
 * `variant`, as Chopin's other components do, so no class or style is built from a caller's value.
 */

import "./composer-model.css";

import type {
	FocusEventHandler,
	KeyboardEventHandler,
	MouseEventHandler,
	ReactNode,
	Ref,
} from "react";

type MenuProps = {
	/** Which menu of the composer: they share one surface, and each sets its own width. */
	variant: "commands" | "mentions";
	children: ReactNode;
	id?: string;
	role?: "dialog";
	"aria-label"?: string;
	onBlur?: FocusEventHandler<HTMLDivElement>;
	onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
	ref?: Ref<HTMLDivElement>;
};

/**
 * The popover over the composer, shared by the `/` commands, the `@` mentions and the models. It
 * is mounted while open and eases in as menus do. It is anchored to the composer's own edge, not
 * to its trigger, so it needs no measuring to stay inside the composer.
 */
export function ComposerMenu(props: MenuProps) {
	return (
		<div
			ref={props.ref}
			aria-label={props["aria-label"]}
			className="composer-menu menu-surface"
			data-chat-command-picker={props.variant === "commands" ? "" : undefined}
			data-chat-mention-picker={props.variant === "mentions" ? "" : undefined}
			data-focus-boundary=""
			data-menu-enter=""
			data-variant={props.variant}
			id={props.id}
			onBlur={props.onBlur}
			onKeyDown={props.onKeyDown}
			// The `/` and `@` lists can scroll, and nothing in them is a tab stop (the draft keeps
			// focus and points at a row), so the region itself is reachable; a press inside never
			// takes the draft's focus away.
			onMouseDown={event => event.preventDefault()}
			role={props.role}
			tabIndex={0}
		>
			{props.children}
		</div>
	);
}

type ItemProps = {
	/** The keyboard or pointer row. */
	active: boolean;
	/** The chosen value; a list with none marks its active row as chosen. */
	selected: boolean;
	/** A command's and a mention's row sit in a line. */
	variant?: "command" | "mention";
	children: ReactNode;
	id: string;
	"aria-label"?: string;
	"data-press"?: "wide";
	onClick: MouseEventHandler<HTMLButtonElement>;
	onMouseDown: MouseEventHandler<HTMLButtonElement>;
	onMouseEnter: MouseEventHandler<HTMLButtonElement>;
};

/** A row of a listbox, shared by the same three. */
export function ComposerMenuItem(props: ItemProps) {
	return (
		<button
			aria-label={props["aria-label"]}
			aria-selected={props.selected}
			className="composer-menu-item menu-item"
			data-active={props.active || undefined}
			data-press={props["data-press"]}
			id={props.id}
			onClick={props.onClick}
			onMouseDown={props.onMouseDown}
			onMouseEnter={props.onMouseEnter}
			role="option"
			tabIndex={-1}
			type="button"
		>
			{props.children}
		</button>
	);
}
