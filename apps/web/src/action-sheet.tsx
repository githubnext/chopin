import { useEffect, useRef, useState } from "react";
import { Drawer } from "@base-ui/react/drawer";

import "./phone-sheets.css";

import type { IconProps } from "@chopin/icons";
import type { ReactNode } from "react";

export type ActionSheetItem<Action extends string> = {
	action: Action;
	label: string;
	icon?: (props: IconProps) => ReactNode;
	/** Only for what cannot be undone; an archive has Undo, so it reads as ordinary. */
	destructive?: boolean;
};

/**
 * A phone's menu: a grouped list rising from the bottom edge with a separate Cancel, the way iOS
 * presents a choice of actions. It renders the same item list a desktop popover does.
 *
 * Copying runs on the tap itself so the clipboard keeps the gesture. Every other choice waits
 * for the sheet to leave, so focus, dialogs and inline fields never contend with its focus trap.
 */
export function ActionSheet<Action extends string>(
	{
		immediate = [],
		items,
		label,
		onClose,
		onSelect,
		title,
	}: {
		immediate?: Action[];
		items: ActionSheetItem<Action>[];
		label: string;
		onClose: () => void;
		onSelect: (action: Action) => void;
		title?: string;
	},
) {
	let [open, setOpen] = useState(false);
	let chosen = useRef<Action | undefined>(undefined);
	useEffect(() => {
		let frame = requestAnimationFrame(() => setOpen(true));
		return () => cancelAnimationFrame(frame);
	}, []);
	let choose = (action: Action) => {
		if (immediate.includes(action)) onSelect(action);
		else chosen.current = action;
		setOpen(false);
	};

	return (
		<Drawer.Root
			onOpenChange={setOpen}
			onOpenChangeComplete={next => {
				if (next) return;
				onClose();
				// Kept rather than cleared: Base UI may restore focus after this callback.
				if (chosen.current) onSelect(chosen.current);
			}}
			open={open}
		>
			<Drawer.Portal>
				<Drawer.Backdrop className="phone-sheet-backdrop" />
				<Drawer.Viewport className="phone-sheet-viewport">
					<Drawer.Popup
						aria-label={label}
						className="action-sheet"
						data-action-sheet=""
						finalFocus={() => chosen.current === undefined}
					>
						<Drawer.Title className="sr-only">{label}</Drawer.Title>
						<div className="action-sheet-group">
							{title && <p className="action-sheet-title">{title}</p>}
							{items.map(item => (
								<button
									className="action-sheet-item"
									data-tone={item.destructive ? "danger" : "normal"}
									key={item.action}
									onClick={() => choose(item.action)}
									type="button"
								>
									{item.icon && <item.icon aria-hidden="true" size={18} />}
									{item.label}
								</button>
							))}
						</div>
						<Drawer.Close className="action-sheet-cancel">Cancel</Drawer.Close>
					</Drawer.Popup>
				</Drawer.Viewport>
			</Drawer.Portal>
		</Drawer.Root>
	);
}
