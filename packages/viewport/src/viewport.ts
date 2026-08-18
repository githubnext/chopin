export type ViewportBox = { left: number; top: number; width: number; height: number };

export type ViewportChangeListener = () => void;

export type ViewportEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export type VisualViewportSource = ViewportEventTarget & {
	height: number;
	offsetLeft: number;
	offsetTop: number;
	width: number;
};

export type ViewportSource = {
	document?: ViewportEventTarget;
	innerHeight: number;
	innerWidth: number;
	visualViewport?: VisualViewportSource | null;
	window: ViewportEventTarget;
};

export type ViewportChangeOptions = {
	observeDocumentScroll?: boolean;
	scrollTargets?: readonly ViewportEventTarget[];
	source?: ViewportSource;
};

/** The pixels currently exposed by the browser, including visual viewport offsets. */
export function currentViewport(source = browserViewportSource()): ViewportBox {
	let visual = source.visualViewport;
	return visual
		? {
			left: visual.offsetLeft,
			top: visual.offsetTop,
			width: visual.width,
			height: visual.height,
		}
		: { left: 0, top: 0, width: source.innerWidth, height: source.innerHeight };
}

/** Subscribe to the browser events that can move fixed geometry. */
export function listenToViewportChanges(
	listener: ViewportChangeListener,
	options: ViewportChangeOptions = {},
): () => void {
	let source = options.source ?? browserViewportSource();
	let visual = source.visualViewport;
	let scrollTargets = options.scrollTargets ?? [];
	source.window.addEventListener("resize", listener);
	visual?.addEventListener("resize", listener);
	visual?.addEventListener("scroll", listener);
	if (options.observeDocumentScroll) source.document?.addEventListener("scroll", listener, true);
	for (let target of scrollTargets) target.addEventListener("scroll", listener);

	return () => {
		source.window.removeEventListener("resize", listener);
		visual?.removeEventListener("resize", listener);
		visual?.removeEventListener("scroll", listener);
		if (options.observeDocumentScroll) {
			source.document?.removeEventListener("scroll", listener, true);
		}
		for (let target of scrollTargets) target.removeEventListener("scroll", listener);
	};
}

function browserViewportSource(): ViewportSource {
	return {
		document,
		innerHeight: window.innerHeight,
		innerWidth: window.innerWidth,
		visualViewport: window.visualViewport,
		window,
	};
}
