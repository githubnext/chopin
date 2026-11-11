/** Adapted from assistant-ui's standalone MessageActions, driven only by props (see NOTICE.md). */
import { useState } from "react";
import { CheckIcon, CopyIcon, EllipsisVerticalIcon, ReactionAddIcon } from "@chopin/icons";

import "./message-actions.css";

import type { ComponentProps, KeyboardEvent, Ref } from "react";

export type QuickReaction = { readonly emoji: string; readonly label: string };

export interface MessageActionsProps extends Omit<ComponentProps<"div">, "children" | "onKeyDown"> {
	quick: readonly QuickReaction[];
	pressed: ReadonlySet<string>;
	reactable: boolean;
	onReact: (emoji: string) => void;
	onAddReaction: () => void;
	onMore: () => void;
	addExpanded: boolean;
	moreExpanded: boolean;
	addControls?: string;
	moreControls?: string;
	addRef?: Ref<HTMLButtonElement>;
	moreRef?: Ref<HTMLButtonElement>;
}

export function MessageActions(
	{
		quick,
		pressed,
		reactable,
		onReact,
		onAddReaction,
		onMore,
		addExpanded,
		moreExpanded,
		addControls,
		moreControls,
		addRef,
		moreRef,
		className,
		...props
	}: MessageActionsProps,
) {
	let [active, setActive] = useState(0);
	let count = reactable ? quick.length + 2 : 1;
	let tab = (index: number) => Math.min(active, count - 1) === index ? 0 : -1;
	let move = (event: KeyboardEvent<HTMLDivElement>) => {
		let step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		let target = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : undefined;
		if (!step && target === undefined) return;
		let buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
		let current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		if (current < 0) return;
		event.preventDefault();
		let next = target ?? (current + step + buttons.length) % buttons.length;
		setActive(next);
		buttons[next]?.focus();
	};

	return (
		<div
			aria-label="Reactions and actions"
			aria-orientation="horizontal"
			className={`message-actions ${className ?? ""}`}
			data-slot="chat-message-actions"
			onKeyDown={move}
			role="toolbar"
			{...props}
		>
			{reactable && quick.map((item, index) => (
				<button
					aria-label={item.label}
					aria-pressed={pressed.has(item.emoji)}
					className="message-actions-button btn btn-icon btn-ghost"
					data-tooltip={item.label}
					data-tooltip-verbatim=""
					key={item.emoji}
					onClick={() => onReact(item.emoji)}
					onFocus={() => setActive(index)}
					tabIndex={tab(index)}
					type="button"
				>
					<span aria-hidden="true" className="message-actions-emoji">{item.emoji}</span>
				</button>
			))}
			{reactable && (
				<button
					aria-controls={addControls}
					aria-expanded={addExpanded}
					aria-haspopup="dialog"
					aria-label="Add reaction"
					className="message-actions-button btn btn-icon btn-ghost"
					data-tooltip="Add reaction"
					onClick={onAddReaction}
					onFocus={() => setActive(quick.length)}
					ref={addRef}
					tabIndex={tab(quick.length)}
					type="button"
				>
					<ReactionAddIcon aria-hidden="true" size={16} />
				</button>
			)}
			<button
				aria-controls={moreControls}
				aria-expanded={moreExpanded}
				aria-haspopup="menu"
				aria-label="Message actions"
				className="message-actions-button btn btn-icon btn-ghost"
				data-tooltip="Message actions"
				onClick={onMore}
				onFocus={() => setActive(count - 1)}
				ref={moreRef}
				tabIndex={tab(count - 1)}
				type="button"
			>
				<EllipsisVerticalIcon aria-hidden="true" size={16} />
			</button>
		</div>
	);
}

export function CopySwap({ copied }: { copied: boolean }) {
	return (
		<span aria-hidden="true" className="message-actions-swap" data-copied={copied || undefined}>
			<CopyIcon />
			<CheckIcon size={16} />
		</span>
	);
}
