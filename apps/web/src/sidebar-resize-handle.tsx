import { useRef } from "react";

import { SIDEBAR_MAX, SIDEBAR_MIN } from "./project-sidebar-chrome";

export function SidebarResizeHandle(
	{ onResize, width }: { onResize: (delta: number) => void; width: number },
) {
	let origin = useRef(0);
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
			onPointerDown={event => {
				origin.current = event.clientX;
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
				let delta = event.clientX - origin.current;
				origin.current = event.clientX;
				onResize(delta);
			}}
			role="separator"
			tabIndex={0}
		/>
	);
}
