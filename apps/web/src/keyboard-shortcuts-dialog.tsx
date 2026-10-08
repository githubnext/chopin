import { useRef, useState } from "react";
import { SearchIcon } from "@chopin/icons";

import { NavigationDialog } from "./navigation-dialog";
import { currentShortcutPlatform, shortcutKeys, SHORTCUTS } from "./shortcuts";

import type { NavigationDialogMotion } from "./navigation-dialog";

export function KeyboardShortcutsDialog(
	{ motion, onDismiss }: { motion: NavigationDialogMotion; onDismiss: () => void },
) {
	let platform = currentShortcutPlatform();
	let input = useRef<HTMLInputElement>(null);
	let [query, setQuery] = useState("");
	let needle = query.trim().toLocaleLowerCase();
	let shown = SHORTCUTS.filter(entry => entry.label.toLocaleLowerCase().includes(needle));
	return (
		<NavigationDialog
			initialFocus={input}
			motion={motion}
			onDismiss={onDismiss}
			palette
			title="Keyboard shortcuts"
		>
			<div className="navigation-palette-search">
				<SearchIcon aria-hidden="true" />
				<label className="sr-only" htmlFor="shortcut-search">Search shortcuts</label>
				<input
					className="navigation-palette-input"
					id="shortcut-search"
					onChange={event => setQuery(event.target.value)}
					placeholder="Search shortcuts…"
					ref={input}
					value={query}
				/>
			</div>
			<div className="navigation-palette-list keyboard-shortcuts">
				{shown.length === 0 && (
					<p className="navigation-palette-status" role="status">No matching shortcuts</p>
				)}
				{(["General", "Editing"] as const).map(group => {
					let entries = shown.filter(entry => entry.group === group);
					if (entries.length === 0) return null;
					return (
						<section aria-label={group} key={group}>
							<h3 className="keyboard-shortcuts-group">{group}</h3>
							<dl>
								{entries.map(entry => (
									<div className="keyboard-shortcuts-row" key={entry.id}>
										<dt>{entry.label}</dt>
										<dd className="shortcut-keys">
											{shortcutKeys(entry.id, platform).map(key => <kbd key={key}>{key}</kbd>)}
										</dd>
									</div>
								))}
							</dl>
						</section>
					);
				})}
			</div>
		</NavigationDialog>
	);
}
