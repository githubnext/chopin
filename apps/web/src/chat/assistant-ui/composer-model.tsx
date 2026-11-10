/**
 * The model picker's elements, adapted from assistant-ui's Composer (MIT, Copyright (c) 2026
 * AgentbaseAI Inc.): `ComposerModelTrigger`, `ComposerMenu`, `ComposerMenuItem` and
 * `ComposerModelItem`, from the registry item `elements-composer` as served on 2026-11-10
 * (repository `main` at f92028b466cba721846de6851e4dddb6c04ecfad). See THIRD_PARTY_NOTICES.md.
 *
 * The standalone lane: every element is driven by props and callbacks and none needs
 * assistant-ui's runtime. Restyled to Chopin's tokens, menu geometry and icons
 * (`composer-model.css`). Each takes the props it needs by name and picks its look from a finite
 * `variant`, as Chopin's other components do, so no class or style is built from a caller's value.
 */

import { BrainSparkleIcon, ChevronIcon } from "@chopin/icons";

import "./composer-model.css";

import type {
	FocusEventHandler,
	KeyboardEventHandler,
	MouseEventHandler,
	ReactNode,
	Ref,
} from "react";

export interface ComposerModel {
	name: string;
	/** Shown right-aligned in tertiary ink, such as "Default". */
	meta?: string;
	/** One line under the name. */
	description?: string;
}

type MenuProps = {
	/** Which menu of the composer: they share one surface, and each sets its own width. */
	variant: "commands" | "mentions" | "models";
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
			data-chat-model-picker={props.variant === "models" ? "" : undefined}
			data-focus-boundary=""
			data-menu-enter=""
			data-slot="composer-menu"
			data-variant={props.variant}
			id={props.id}
			onBlur={props.onBlur}
			onKeyDown={props.onKeyDown}
			role={props.role}
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
	/** A model's row stacks its description under its name. */
	variant?: "model";
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
			data-slot="composer-menu-item"
			data-variant={props.variant}
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

type TriggerProps = {
	model: string;
	/** The reasoning level somebody chose, in words. */
	level?: string;
	open: boolean;
	onClick: MouseEventHandler<HTMLButtonElement>;
	"aria-controls"?: string;
	"aria-label": string;
	title: string;
	ref?: Ref<HTMLButtonElement>;
};

/**
 * The control that names the model that will run. On a phone it is the icon and the short name,
 * the level and chevron left to the accessible name. It never manages its own open state: the
 * caller owns both.
 */
export function ComposerModelTrigger(props: TriggerProps) {
	return (
		<button
			ref={props.ref}
			aria-controls={props["aria-controls"]}
			aria-expanded={props.open}
			aria-haspopup="dialog"
			aria-label={props["aria-label"]}
			className="composer-model-trigger btn btn-sm btn-ghost"
			data-press="none"
			data-slot="composer-model-trigger"
			onClick={props.onClick}
			title={props.title}
			type="button"
		>
			<span aria-hidden="true" className="composer-model-symbol">
				<BrainSparkleIcon size={16} />
			</span>
			<span aria-hidden="true" className="composer-model-name">{props.model}</span>
			{props.level && <span aria-hidden="true" className="composer-model-level">{props.level}
			</span>}
			<ChevronIcon aria-hidden="true" className="composer-model-chevron" size={12} />
		</button>
	);
}

type ModelItemProps = {
	entry: ComposerModel;
	selected: boolean;
	active: boolean;
	id: string;
	onClick: MouseEventHandler<HTMLButtonElement>;
	onMouseDown: MouseEventHandler<HTMLButtonElement>;
	onMouseEnter: MouseEventHandler<HTMLButtonElement>;
};

/** A model's row: its name, one line of description under it and its detail at the end. */
export function ComposerModelItem(props: ModelItemProps) {
	return (
		<ComposerMenuItem
			active={props.active}
			id={props.id}
			onClick={props.onClick}
			onMouseDown={props.onMouseDown}
			onMouseEnter={props.onMouseEnter}
			selected={props.selected}
			variant="model"
		>
			<span className="composer-model-row">
				<span className="composer-model-row-name">{props.entry.name}</span>
				{props.entry.description && (
					<span className="composer-model-row-description">{props.entry.description}</span>
				)}
			</span>
			{props.entry.meta && <span className="composer-model-row-meta">{props.entry.meta}</span>}
		</ComposerMenuItem>
	);
}
