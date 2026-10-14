import { useCallback, useSyncExternalStore } from "react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { ArrowLeftIcon, ArrowRightIcon, DocumentIcon, UndoIcon } from "@chopin/icons";
import { motionImmediately } from "./motion-input";
import { NavigationDialog } from "./navigation-dialog";
import { TerminalAlert } from "./terminal-alert";
import type { DocumentRecoveryStore } from "./document-development-recovery-store";

export function DocumentRecoveryControl(
	{ canEdit, connected, documentHeadingId, store }: {
		canEdit: boolean;
		connected: boolean;
		documentHeadingId: string;
		store: DocumentRecoveryStore;
	},
) {
	let snapshot = useSyncExternalStore(store.subscribe, store.get, store.get);
	let presence = useTransitionPresence(snapshot.open ? true : undefined, 150, motionImmediately());
	let { items, selected, source, loading, resolving, error } = snapshot;
	let fallbackFocus = useCallback(() => {
		let heading = document.getElementById(documentHeadingId);
		return heading?.parentElement?.querySelector<HTMLElement>('[role="textbox"][contenteditable]')
			?? heading;
	}, [documentHeadingId]);
	return (
		<>
			{items.length > 0 && (
				<div className="document-development min-w-0 shrink-0">
					<button
						aria-haspopup="dialog"
						aria-label={`Recovered edits (${items.length})`}
						className="btn btn-sm btn-ghost max-w-full gap-1 text-text-tertiary"
						data-tooltip={`Recovered edits (${items.length})`}
						onClick={store.open}
						type="button"
					>
						<UndoIcon
							aria-hidden="true"
							className="document-development-glyph shrink-0"
							size={14}
						/>
						<span data-status-label>Recovered edits</span>
						<span aria-hidden="true" className="tabular-nums">({items.length})</span>
					</button>
				</div>
			)}
			{presence.phase !== "closed" && (
				<NavigationDialog
					className="document-recovery-dialog"
					fallbackFocus={fallbackFocus}
					motion={presence}
					onDismiss={store.close}
					title="Recovered edits"
				>
					{!selected
						? (
							<>
								<p className="mt-2 text-sm text-text-secondary">
									These edits arrived after their passage changed. Your text is saved here.
								</p>
								<ul className="navigation-dialog-list">
									{items.map(item => (
										<li key={item.id}>
											<button
												className="navigation-dialog-option text-sm text-text-primary"
												disabled={!connected}
												onClick={() => void store.read(item)}
												type="button"
											>
												<DocumentIcon
													aria-hidden="true"
													className="shrink-0 text-text-tertiary"
													size={14}
												/>
												<span className="min-w-0 flex-1 break-words">{item.preview}</span>
												<ArrowRightIcon
													aria-hidden="true"
													className="shrink-0 text-text-tertiary"
													size={14}
												/>
											</button>
										</li>
									))}
								</ul>
							</>
						)
						: (
							<>
								<button className="btn btn-sm btn-ghost mt-2" onClick={store.back} type="button">
									<ArrowLeftIcon aria-hidden="true" size={14} />
									All recovered edits
								</button>
								{loading && (
									<p className="mt-3 text-sm text-text-secondary" role="status">
										Loading saved text…
									</p>
								)}
								{source !== undefined && (
									<div
										aria-label="Saved human text"
										className="mt-3 max-h-[50svh] overflow-auto whitespace-pre-wrap break-words text-sm text-text-primary"
										role="region"
										tabIndex={0}
									>
										{source}
									</div>
								)}
								{error && (
									<TerminalAlert className="mt-3 text-sm text-destructive-ink">
										{error}
									</TerminalAlert>
								)}
								{error && source === undefined && (
									<button
										className="btn btn-sm btn-secondary mt-3"
										disabled={!connected || loading}
										onClick={() => void store.read(selected)}
										type="button"
									>
										Try again
									</button>
								)}
								{canEdit && source !== undefined && (
									<div className="mt-4 flex flex-wrap justify-end gap-2">
										<button
											className="btn btn-md btn-secondary"
											disabled={!connected || !!resolving}
											onClick={() => void store.resolve("dismiss")}
											type="button"
										>
											{resolving === "dismiss" ? "Dismissing…" : "Dismiss"}
										</button>
										<button
											aria-busy={resolving === "add"}
											className="btn btn-md btn-primary"
											disabled={!connected || !!resolving}
											onClick={() => void store.resolve("add")}
											type="button"
										>
											{resolving === "add" ? "Adding…" : "Add to document"}
										</button>
									</div>
								)}
							</>
						)}
					<div className="mt-3 flex justify-end">
						<button className="btn btn-sm btn-ghost" onClick={store.close} type="button">
							Close
						</button>
					</div>
				</NavigationDialog>
			)}
		</>
	);
}
