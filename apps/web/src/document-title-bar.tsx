/**
 * The split sheet's two bars: the title bar (Chat toggle | title ... status | people) and the
 * views bar beneath it.
 */

import type { ReactNode } from "react";

export function DocumentTitleBar(
	{ controls, cover, presence, status, title, titleInert, toggle, viewsFolded, viewsInert }: {
		/** The document's views, in the bar beneath the title. */
		controls: ReactNode;
		/** A control filling the whole title bar beneath its contents, as a covered Lift root's Back. */
		cover?: ReactNode;
		/** People present in the room, at the end of the title bar. */
		presence?: ReactNode;
		/** Connection and document status, right-aligned before the people. */
		status?: ReactNode;
		title: ReactNode;
		titleInert?: boolean;
		/** The Chat toggle, behind a rule at the start of the bar. */
		toggle?: ReactNode;
		viewsFolded?: boolean;
		viewsInert?: boolean;
	},
) {
	return (
		<>
			<div
				className="document-title-bar panel-header flex shrink-0 items-center px-(--panel-toolbar-padding-inline) hairline-b"
				data-document-title-bar
			>
				{cover}
				{toggle && (
					<span className="workspace-surface-toggle-slot flex shrink-0 items-center">
						{toggle}
					</span>
				)}
				<div className="document-title-slot" inert={titleInert || undefined}>
					{title}
				</div>
				<div className="document-title-trailing" data-toolbar-trailing>
					<div className="document-title-status">{status}</div>
					{presence}
				</div>
			</div>
			<div
				className="document-views-bar panel-header flex shrink-0 items-center overflow-x-auto overflow-y-hidden px-(--panel-toolbar-padding-inline)"
				data-document-toolbar
				data-folded={viewsFolded || undefined}
				inert={viewsInert || viewsFolded || undefined}
				onFocusCapture={event => {
					if (!(event.target instanceof HTMLElement)) return;
					let control = event.target.getBoundingClientRect();
					let toolbar = event.currentTarget.getBoundingClientRect();
					if (control.left < toolbar.left) {
						event.currentTarget.scrollLeft += Math.floor(control.left - toolbar.left);
					} else if (control.right > toolbar.right) {
						event.currentTarget.scrollLeft += Math.ceil(control.right - toolbar.right);
					}
				}}
			>
				{controls}
			</div>
		</>
	);
}
