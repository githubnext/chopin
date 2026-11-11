/**
 * The `/` commands and `@` mentions rows, adapted from assistant-ui's Composer (MIT, Copyright (c)
 * 2026 AgentbaseAI Inc.): `ComposerCommandItem` and `ComposerPersonItem`, from the registry item
 * `elements-composer` as served on 2026-11-10 (repository `main` at
 * f92028b466cba721846de6851e4dddb6c04ecfad), documented at
 * <https://www.assistant-ui.com/elements/composer-slash-commands> and
 * <https://www.assistant-ui.com/elements/composer-mentions>. See THIRD_PARTY_NOTICES.md.
 *
 * The standalone lane: both are driven by props and callbacks, and neither needs assistant-ui's
 * runtime. Upstream's `useSlashMatches`, `useMentionMatches` and `applyMention` are Chat's own
 * pure functions (`commands.ts`, `mentions.ts`), which also keep the caret and the draft's chips.
 *
 * What changed: the row is `ComposerMenuItem` (Chopin's menu row, the rows of the model picker),
 * styled in Chopin's tokens and text roles (`composer-commands.css`); the Lucide icon and the
 * initial-letter avatar are Chopin's icons and faces, passed in as `lead`; the active row's `↵`
 * hint is drawn for a pointer that hovers and left out on touch; a name is never cut where it
 * could be the only thing telling two rows apart. Added: `ComposerMenuGroup`, a heading over a run
 * of rows (the runtime lane's categories), so commands are grouped by where they come from.
 */

import { ComposerMenuItem } from "./composer-model";

import "./composer-commands.css";

import type { MouseEventHandler, ReactNode } from "react";

type RowProps = {
	/** The keyboard or pointer row. */
	active: boolean;
	id: string;
	onClick: MouseEventHandler<HTMLButtonElement>;
	onMouseDown: MouseEventHandler<HTMLButtonElement>;
	onMouseEnter: MouseEventHandler<HTMLButtonElement>;
	"aria-label"?: string;
};

/** A heading over a run of rows of one listbox, read as a group of that name. */
export function ComposerMenuGroup(
	{ children, id, label }: { children: ReactNode; id: string; label: string },
) {
	return (
		<div aria-labelledby={id} data-slot="composer-menu-group" role="group">
			<div aria-hidden="true" className="composer-menu-group-label" id={id}>{label}</div>
			{children}
		</div>
	);
}

/** A command's row: its icon, `/name`, one line of description and, on the active row, `↵`. */
export function ComposerCommandItem(
	props: RowProps & {
		lead: ReactNode;
		name: string;
		description?: string;
	},
) {
	return (
		<ComposerMenuItem
			active={props.active}
			aria-label={props["aria-label"]}
			data-press="wide"
			id={props.id}
			onClick={props.onClick}
			onMouseDown={props.onMouseDown}
			onMouseEnter={props.onMouseEnter}
			selected={props.active}
			variant="command"
		>
			<span aria-hidden="true" className="composer-row-lead">{props.lead}</span>
			<span className="composer-command-name">/{props.name}</span>
			{props.description && (
				<span className="composer-row-description" title={props.description}>
					{props.description}
				</span>
			)}
			{props.active && <kbd aria-hidden="true" className="composer-row-hint">↵</kbd>}
		</ComposerMenuItem>
	);
}

/** A mention's row: a face or an icon, the name, and what kind of thing it is at the end. */
export function ComposerPersonItem(
	props: RowProps & {
		lead: ReactNode;
		name: string;
		/** Shown right-aligned in tertiary ink, such as a heading's level. */
		meta?: string;
	},
) {
	return (
		<ComposerMenuItem
			active={props.active}
			aria-label={props["aria-label"]}
			id={props.id}
			onClick={props.onClick}
			onMouseDown={props.onMouseDown}
			onMouseEnter={props.onMouseEnter}
			selected={props.active}
			variant="mention"
		>
			<span aria-hidden="true" className="composer-row-lead">{props.lead}</span>
			<span className="composer-mention-name">{props.name}</span>
			{props.meta && <span className="composer-row-meta">{props.meta}</span>}
		</ComposerMenuItem>
	);
}
