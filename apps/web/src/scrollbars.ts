/**
 * Mirrors whether the system reserves a classic scrollbar gutter into
 * `data-scrollbars`, so styled scrollbars never replace macOS overlay ones.
 * Call before the first render: WebKit styles a scrollbar only when it creates
 * one. The probe keeps native scrollbars, and its content box resizes when the
 * system switches style, for example when a mouse is connected.
 */
export function watchScrollbarStyle(): void {
	let probe = document.createElement("div");
	probe.dataset.scrollbarProbe = "";
	probe.setAttribute("aria-hidden", "true");
	probe.style.cssText = "position:fixed;top:0;left:0;width:100px;height:100px;"
		+ "overflow:scroll;visibility:hidden;pointer-events:none;scrollbar-width:auto";
	document.body.append(probe);
	let measure = () => {
		document.documentElement.dataset.scrollbars = probe.offsetWidth > probe.clientWidth
			? "classic"
			: "overlay";
	};
	measure();
	new ResizeObserver(measure).observe(probe);
}
