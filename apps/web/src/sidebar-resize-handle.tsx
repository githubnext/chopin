import { usePaneDrag } from "./resizable-pane";
import { SIDEBAR_MAX, SIDEBAR_MIN } from "./project-sidebar-chrome";

export function SidebarResizeHandle(
	{ onCommit, onResize, onShow, width }: {
		/** The width a drag ended on, once. */
		onCommit: (width: number) => void;
		/** A keyboard step. */
		onResize: (delta: number) => void;
		/** The width under the pointer, written straight to the page once per frame while dragging. */
		onShow: (width: number) => void;
		width: number;
	},
) {
	let drag = usePaneDrag({
		commit: onCommit,
		max: SIDEBAR_MAX,
		min: SIDEBAR_MIN,
		show: onShow,
		side: "right",
		width,
	});
	return (
		<div
			aria-label="Resize Projects sidebar"
			aria-orientation="vertical"
			aria-valuemax={SIDEBAR_MAX}
			aria-valuemin={SIDEBAR_MIN}
			aria-valuenow={width}
			className="project-sidebar-resize"
			onKeyDown={event => {
				let step = event.shiftKey ? 64 : 16;
				if (event.key === "ArrowRight") onResize(step);
				else if (event.key === "ArrowLeft") onResize(-step);
				else if (event.key === "Home") onResize(SIDEBAR_MIN - width);
				else if (event.key === "End") onResize(SIDEBAR_MAX - width);
				else return;
				event.preventDefault();
			}}
			onLostPointerCapture={drag.onLostPointerCapture}
			onPointerDown={drag.onPointerDown}
			onPointerMove={drag.onPointerMove}
			role="separator"
			tabIndex={0}
		/>
	);
}
