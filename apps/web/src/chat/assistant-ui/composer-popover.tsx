/**
 * The popover over the composer that `@` and `/` open: assistant-ui's Composer menu, copied and
 * recorded, with its own rows (`ComposerPersonItem`, `ComposerCommandItem`) drawn into it by
 * `mention-picker.tsx` and `command-picker.tsx`. Chopin's state drives it through props.
 *
 * The element's menu is always in the page and fades in when `open` turns true; this one is mounted
 * while there is something to pick, so it opens one frame after it is drawn, which is when the
 * element's own transition has a closed state to leave. Its list is one listbox the draft points at
 * (`aria-activedescendant`), reachable by keyboard because it can scroll, and no press in it takes
 * the draft's focus away.
 */

import { useEffect, useState } from "react";
import { ComposerMenu } from "@/components/assistant-ui/elements/composer";

import type { ReactNode } from "react";

export function ComposerPopover(
	{ children, id, kind, label }: {
		children: ReactNode;
		id: string;
		kind: "commands" | "mentions";
		label: string;
	},
) {
	let [open, setOpen] = useState(false);
	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);
	return (
		<ComposerMenu
			data-chat-command-picker={kind === "commands" ? "" : undefined}
			data-chat-mention-picker={kind === "mentions" ? "" : undefined}
			onMouseDown={event => event.preventDefault()}
			open={open}
		>
			<div
				aria-label={label}
				className="composer-menu-list"
				data-chopin-control=""
				data-focus-boundary=""
				id={id}
				role="listbox"
				tabIndex={0}
			>
				{children}
			</div>
		</ComposerMenu>
	);
}
