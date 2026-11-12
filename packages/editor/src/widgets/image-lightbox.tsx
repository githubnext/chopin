/**
 * The viewer every picture opens in, Chat's and the document's, drawn as Slack's image viewer is.
 *
 * The whole window, over a dimmed and heavily blurred copy of the picture; who sent it (or the
 * document it is in), where and when, and its name along the top, with Close at the top end; the
 * picture in the middle, fitted with a margin; rotate, zoom out, the zoom slider and zoom in at the
 * bottom start; Download alone at the bottom end. Several pictures, or a message's files with them,
 * step with Previous and Next at the sides and the arrow keys. A file shows as its text or as a
 * card. It is loaded only when something opens it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import {
	ChevronIcon,
	CloseIcon,
	DownloadIcon,
	FileIcon,
	ImageOffIcon,
	MinusIcon,
	PlusIcon,
	RotateIcon,
	SparkleIcon,
} from "@chopin/icons";

import {
	arrowStep,
	clampPan,
	clampZoom,
	detailLine,
	downloadName,
	fileNameOf,
	fitScale,
	pinch,
	relativeTime,
	scaleOf,
	shownSize,
	sliderOf,
	stepImage,
	toggleZoom,
	wrapTab,
	zoomAt,
	zoomBounds,
	zoomKey,
	zoomStep,
} from "./image-lightbox-state";
import "./image-lightbox.css";

import type { Point, Size } from "./image-lightbox-state";

export type LightboxImage = {
	kind?: "image";
	/** The address drawn: a large copy, where the original is larger still. */
	src: string;
	alt: string;
	caption?: string;
	generated?: boolean;
	/** The name along the top, where the alt text is not it. */
	name?: string;
	/** The address Download saves, where it is not the one drawn. */
	original?: string;
	/** The name Download saves it under. */
	download?: string;
	/** A line under the name, such as that a smaller copy is shown. */
	note?: string;
};

export type LightboxFile = {
	kind: "file";
	name: string;
	href: string;
	/** Read and shown as text; anything else is a card of its name, type and size. */
	text?: boolean;
	type?: string;
	size?: string;
	icon?: ReactNode;
};

export type LightboxItem = LightboxImage | LightboxFile;

/** Who sent what is shown: their face, their name as written, and when, in milliseconds. */
export type LightboxSender = { name: string; face?: ReactNode; at?: number };

type View = { scale?: number; pan: Point; turns: number };

const FOCUSABLE =
	"button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";
const FIT: View = { pan: { x: 0, y: 0 }, turns: 0 };
/** As long as the closing fade in `image-lightbox.css`. */
const CLOSING_MS = 120;
/** Text past this is left to the download. */
const TEXT_LIMIT = 200_000;

function labelOf(item: LightboxItem): string {
	if (item.kind === "file") return item.name;
	return item.name?.trim() || item.alt.trim() || fileNameOf(item.src)
		|| (item.generated ? "Generated image" : "Image");
}

function click(href: string, name?: string) {
	let link = document.createElement("a");
	link.href = href;
	if (name === undefined) {
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	} else link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
}

function foreign(href: string): boolean {
	let url = new URL(href, location.href);
	return /^https?:$/.test(url.protocol) && url.origin !== location.origin;
}

/**
 * Saves the original under its name: read as bytes, so a signed-in upload and a data or blob
 * address save as files, and a picture on another site whose host refuses the read opens in a tab.
 */
async function save(href: string, name: string): Promise<"saved" | "opened"> {
	try {
		let response = await fetch(href, { referrerPolicy: "no-referrer" });
		if (!response.ok) throw new Error(`The file answered ${response.status}.`);
		let blob = await response.blob();
		let object = URL.createObjectURL(blob);
		click(object, downloadName(name, blob.type));
		setTimeout(() => URL.revokeObjectURL(object), 40_000);
		return "saved";
	} catch (error) {
		if (!foreign(href)) throw error;
		click(href);
		return "opened";
	}
}

function reducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function FileView({ item }: { item: LightboxFile }) {
	let [read, setRead] = useState<{ href: string; text?: string; failed?: boolean }>();
	useEffect(() => {
		if (!item.text) return;
		let controller = new AbortController();
		fetch(item.href, { referrerPolicy: "no-referrer", signal: controller.signal })
			.then(response => {
				if (!response.ok) throw new Error(`The file answered ${response.status}.`);
				return response.text();
			})
			.then(
				text => setRead({ href: item.href, text }),
				() => {
					if (!controller.signal.aborted) setRead({ href: item.href, failed: true });
				},
			);
		return () => controller.abort();
	}, [item.href, item.text]);
	let current = read?.href === item.href ? read : undefined;

	if (item.text && !current?.failed) {
		let text = current?.text;
		return (
			<div className="image-viewer-sheet" data-image-viewer-file="text">
				{text === undefined
					? <p className="image-viewer-sheet-quiet">Loading {item.name}</p>
					: (
						<pre aria-label={item.name} className="image-viewer-text" tabIndex={0}>
							{text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text}
						</pre>
					)}
				{text !== undefined && text.length > TEXT_LIMIT && (
					<p className="image-viewer-sheet-quiet">Download the file to read the rest.</p>
				)}
			</div>
		);
	}
	return (
		<div className="image-viewer-card" data-image-viewer-file="card">
			<span aria-hidden="true" className="image-viewer-card-icon">
				{item.icon ?? <FileIcon size={24} />}
			</span>
			<span className="image-viewer-card-text">
				<span className="image-viewer-card-name">{item.name}</span>
				{(item.type || item.size) && (
					<span className="image-viewer-card-detail">
						{item.type && <span>{item.type}</span>}
						{item.size && <span>{item.size}</span>}
					</span>
				)}
				{current?.failed && (
					<span className="image-viewer-card-detail">This file could not be shown here.</span>
				)}
			</span>
		</div>
	);
}

export function ImageLightbox(
	{ images, onClose, place, sender, start = 0 }: {
		images: readonly LightboxItem[];
		onClose: () => void;
		/** The document's title, or "a thread in" it. */
		place?: string;
		sender?: LightboxSender;
		start?: number;
	},
) {
	let dialog = useRef<HTMLDialogElement>(null);
	let stage = useRef<HTMLDivElement>(null);
	let closer = useRef<HTMLButtonElement>(null);
	let previous = useRef<HTMLButtonElement>(null);
	let next = useRef<HTMLButtonElement>(null);
	let [index, setIndex] = useState(() => stepImage(start, 0, images.length));
	let [view, setView] = useState<View>(FIT);
	let [sizes, setSizes] = useState<Readonly<Record<string, Size>>>({});
	let [box, setBox] = useState<{ fit: Size; stage: Size }>();
	let [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
	let [gesture, setGesture] = useState(false);
	let [closing, setClosing] = useState(false);
	let [said, setSaid] = useState("");
	let [now] = useState(() => Date.now());
	let closed = useRef(false);
	let item = images[index];
	let many = images.length > 1;
	let picture = item && item.kind !== "file" ? item : undefined;
	let broken = picture ? failed.has(picture.src) : false;
	let natural = picture && !broken ? sizes[picture.src] : undefined;

	let fit = natural && box ? fitScale(natural, box.fit, view.turns) : 1;
	let bounds = zoomBounds(fit);
	let scale = clampZoom(view.scale ?? fit, bounds);
	let shown = natural ? shownSize(natural, scale, view.turns) : undefined;
	let pan = shown && box ? clampPan(view.pan, shown, box.stage) : { x: 0, y: 0 };
	let zoomed = scale > bounds.min * 1.001;
	let zoomable = !!natural && bounds.max > bounds.min;

	let close = () => {
		if (closed.current) return;
		if (reducedMotion()) {
			closed.current = true;
			onClose();
			return;
		}
		setClosing(true);
		setTimeout(() => {
			if (closed.current) return;
			closed.current = true;
			onClose();
		}, CLOSING_MS);
	};

	useLayoutEffect(() => {
		let element = dialog.current;
		let opener = document.activeElement;
		element?.showModal();
		closer.current?.focus();
		return () => {
			if (element?.open) element.close();
			if (opener instanceof HTMLElement && opener.isConnected) {
				opener.focus({ preventScroll: true });
			}
		};
	}, []);

	useLayoutEffect(() => {
		let element = stage.current;
		if (!element) return;
		let measure = () => {
			let style = getComputedStyle(element);
			let across = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
			let down = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
			let width = element.clientWidth;
			let height = element.clientHeight;
			setBox({
				fit: { width: Math.max(width - across, 1), height: Math.max(height - down, 1) },
				stage: { width, height },
			});
		};
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	let show = (delta: -1 | 1) => {
		let to = stepImage(index, delta, images.length);
		if (to === index) return;
		// A button about to be disabled cannot keep focus, so the other one takes it.
		if (to === 0 && document.activeElement === previous.current) next.current?.focus();
		else if (to === images.length - 1 && document.activeElement === next.current) {
			previous.current?.focus();
		}
		setIndex(to);
		setView(FIT);
		setSaid("");
	};

	/** Zooms about a point given from the stage's centre, from the scale the view has by then. */
	let zoomTo = (to: number | ((from: number) => number), point: Point = { x: 0, y: 0 }) => {
		setView(current => {
			let from = clampZoom(current.scale ?? fit, bounds);
			let target = clampZoom(typeof to === "function" ? to(from) : to, bounds);
			if (target <= bounds.min) return { ...current, scale: target, pan: { x: 0, y: 0 } };
			let moved = zoomAt(current.pan, point, from, target);
			let size = natural && box ? shownSize(natural, target, current.turns) : undefined;
			return {
				...current,
				scale: target,
				pan: size && box ? clampPan(moved, size, box.stage) : moved,
			};
		});
	};

	/** Moves a zoomed picture by a drag's step, as far as its edges allow. */
	let panBy = (dx: number, dy: number) => {
		setView(current => {
			let size = natural && box
				? shownSize(natural, clampZoom(current.scale ?? fit, bounds), current.turns)
				: undefined;
			let moved = { x: current.pan.x + dx, y: current.pan.y + dy };
			return { ...current, pan: size && box ? clampPan(moved, size, box.stage) : moved };
		});
	};

	let rotate = () => setView(current => ({ turns: current.turns + 1, pan: { x: 0, y: 0 } }));

	// Read by listeners that are added once, so each sees this render's values.
	let latest = useRef({ show, zoomTo, scale, bounds, zoomable, setGesture });
	latest.current = { show, zoomTo, scale, bounds, zoomable, setGesture };

	useEffect(() => {
		let onKeyDown = (event: KeyboardEvent) => {
			let target = event.target as Element | null;
			let field = target instanceof HTMLInputElement;
			let plain = !event.altKey && !event.ctrlKey && !event.metaKey;
			let step = arrowStep(event.key);
			if (step && plain && !field) {
				event.preventDefault();
				latest.current.show(step);
				return;
			}
			let zoom = zoomKey(event.key);
			if (zoom && plain && latest.current.zoomable) {
				event.preventDefault();
				let { bounds, scale } = latest.current;
				latest.current.zoomTo(zoom === "fit" ? bounds.min : zoomStep(scale, zoom, bounds));
				return;
			}
			if (event.key !== "Tab") return;
			let controls = [...dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []];
			let to = wrapTab(
				controls.indexOf(document.activeElement as HTMLElement),
				controls.length,
				event.shiftKey,
			);
			if (to === undefined) return;
			event.preventDefault();
			controls[to]?.focus();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, []);

	// The wheel and a trackpad's pinch zoom about the pointer; the page behind never scrolls.
	useEffect(() => {
		let element = stage.current;
		if (!element) return;
		let settle: ReturnType<typeof setTimeout> | undefined;
		let onWheel = (event: WheelEvent) => {
			event.preventDefault();
			let { setGesture, zoomable, zoomTo } = latest.current;
			if (!zoomable) return;
			let lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
			let factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.002));
			let rect = element.getBoundingClientRect();
			// The picture follows the wheel at once; easing each tick would trail behind it.
			setGesture(true);
			clearTimeout(settle);
			settle = setTimeout(() => latest.current.setGesture(false), 150);
			zoomTo(from => from * factor, {
				x: event.clientX - rect.left - rect.width / 2,
				y: event.clientY - rect.top - rect.height / 2,
			});
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			clearTimeout(settle);
			element.removeEventListener("wheel", onWheel);
		};
	}, []);

	// Fingers and a dragging mouse: one pans a zoomed picture, two pinch.
	let pointers = useRef(new Map<number, Point>());
	let moved = useRef(false);
	let fromCentre = (point: Point): Point => {
		let rect = stage.current!.getBoundingClientRect();
		return { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 };
	};

	if (!item) return null;
	let label = labelOf(item);
	let time = sender?.at === undefined ? undefined : relativeTime(sender.at, now);
	let heading = sender?.name ?? place ?? label;
	let detail = sender
		? detailLine({ file: label, place, time })
		: place
		? label
		: undefined;
	let download = item.kind === "file"
		? { href: item.href, name: item.name }
		: {
			href: item.original ?? item.src,
			name: item.download ?? item.name ?? (item.alt.trim() || fileNameOf(item.src) || "image"),
		};
	let noun = item.kind === "file" ? "file" : "image";

	return createPortal(
		<dialog
			ref={dialog}
			aria-describedby="image-viewer-detail"
			aria-label={item.kind === "file" ? "File preview" : "Image preview"}
			className="image-viewer"
			data-closing={closing ? "" : undefined}
			data-focus-boundary=""
			data-image-viewer=""
			onCancel={event => {
				event.preventDefault();
				close();
			}}
			onClose={event => {
				// A close the dialog's own remount already undid (React's development double effect) is not one.
				if (closed.current || event.currentTarget.open) return;
				closed.current = true;
				onClose();
			}}
			onClick={event => {
				// The viewer is portalled, so React would carry its events to whatever opened it.
				event.stopPropagation();
				let target = event.target as HTMLElement;
				if (target.closest("[data-image-viewer-ground]") === target) close();
			}}
			onKeyDown={event => event.stopPropagation()}
		>
			{picture && !broken && (
				<div aria-hidden="true" className="image-viewer-backdrop">
					<img alt="" key={picture.src} referrerPolicy="no-referrer" src={picture.src} />
				</div>
			)}
			<header className="image-viewer-header" data-image-viewer-ground="">
				{sender?.face && <span aria-hidden="true" className="image-viewer-face">{sender.face}
				</span>}
				<div className="image-viewer-who" id="image-viewer-detail">
					<p className="image-viewer-name">{heading}</p>
					{detail && (
						<p className="image-viewer-detail">
							<span className="image-viewer-detail-text">{detail}</span>
							{picture?.generated && (
								<span className="image-viewer-generated">
									<SparkleIcon aria-hidden="true" size={12} />
									Generated
								</span>
							)}
						</p>
					)}
					{picture?.note && <p className="image-viewer-note">{picture.note}</p>}
				</div>
				<button
					ref={closer}
					aria-label="Close"
					className="image-viewer-control"
					data-image-viewer-close=""
					onClick={close}
					type="button"
				>
					<CloseIcon aria-hidden="true" size={18} />
				</button>
			</header>
			<div
				ref={stage}
				className="image-viewer-stage"
				data-gesture={gesture ? "" : undefined}
				data-image-viewer-ground=""
				data-many={many ? "" : undefined}
				data-zoomed={zoomed ? "" : undefined}
				onClickCapture={event => {
					// The click that ends a drag is the drag's, not a press on the ground.
					if (moved.current) {
						event.stopPropagation();
						moved.current = false;
					}
				}}
				onPointerDown={event => {
					if (!natural || event.button !== 0) return;
					// A mouse has one pointer; one whose release fell outside the window is gone.
					if (event.pointerType === "mouse") pointers.current.clear();
					pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
					moved.current = false;
					if (pointers.current.size === 2 || zoomed) setGesture(true);
				}}
				onPointerMove={event => {
					let last = pointers.current.get(event.pointerId);
					if (!last) return;
					let point = { x: event.clientX, y: event.clientY };
					if (pointers.current.size === 2) {
						let [first, second] = [...pointers.current.entries()];
						let before = [first![1], second![1]] as const;
						pointers.current.set(event.pointerId, point);
						let after = [
							pointers.current.get(first![0])!,
							pointers.current.get(second![0])!,
						] as const;
						let { centre, ratio } = pinch(before, after);
						moved.current = true;
						zoomTo(from => from * ratio, fromCentre(centre));
						return;
					}
					pointers.current.set(event.pointerId, point);
					if (!zoomed) return;
					let dx = point.x - last.x;
					let dy = point.y - last.y;
					if (dx === 0 && dy === 0) return;
					// Held only once it drags, so a press that does not move stays a click on what it pressed.
					if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
						event.currentTarget.setPointerCapture(event.pointerId);
					}
					moved.current = true;
					panBy(dx, dy);
				}}
				onPointerUp={event => {
					pointers.current.delete(event.pointerId);
					if (pointers.current.size === 0) setGesture(false);
				}}
				onPointerCancel={event => {
					pointers.current.delete(event.pointerId);
					if (pointers.current.size === 0) setGesture(false);
				}}
			>
				{item.kind === "file"
					? <FileView item={item} />
					: broken
					? (
						<div
							className="image-viewer-broken"
							role="img"
							aria-label={item.alt || "Image"}
						>
							<ImageOffIcon aria-hidden="true" size={24} />
							<span>This image could not be loaded.</span>
						</div>
					)
					: (
						<img
							alt={item.alt || label}
							className="image-viewer-image"
							data-image-viewer-image=""
							data-rotation={(view.turns % 4) * 90}
							data-shown={shown ? "" : undefined}
							draggable={false}
							key={item.src}
							onDoubleClick={event => {
								if (!zoomable) return;
								zoomTo(
									toggleZoom(scale, bounds),
									fromCentre({ x: event.clientX, y: event.clientY }),
								);
							}}
							onError={() => setFailed(new Set(failed).add(item.src))}
							onLoad={event => {
								let { naturalHeight: height, naturalWidth: width } = event.currentTarget;
								if (width && height) {
									setSizes(current => ({
										...current,
										[item.src]: { width, height },
									}));
								}
							}}
							referrerPolicy="no-referrer"
							src={item.src}
							style={natural
								? {
									width: natural.width * scale,
									height: natural.height * scale,
									transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) rotate(${
										view.turns * 90
									}deg)`,
								}
								: undefined}
						/>
					)}
			</div>
			{many && (
				<>
					<button
						ref={previous}
						aria-label="Previous"
						className="image-viewer-control image-viewer-step"
						data-image-viewer-step="previous"
						disabled={index === 0}
						onClick={() => show(-1)}
						type="button"
					>
						<ChevronIcon aria-hidden="true" className="rotate-180" size={18} />
					</button>
					<button
						ref={next}
						aria-label="Next"
						className="image-viewer-control image-viewer-step"
						data-image-viewer-step="next"
						disabled={index === images.length - 1}
						onClick={() => show(1)}
						type="button"
					>
						<ChevronIcon aria-hidden="true" size={18} />
					</button>
				</>
			)}
			<footer className="image-viewer-footer" data-image-viewer-ground="">
				<div className="image-viewer-tools">
					{picture && (
						<>
							<span className="image-viewer-group">
								<button
									aria-label="Rotate"
									className="image-viewer-control"
									disabled={!natural}
									onClick={rotate}
									type="button"
								>
									<RotateIcon aria-hidden="true" size={18} />
								</button>
							</span>
							<span className="image-viewer-group" role="group" aria-label="Zoom">
								<button
									aria-label="Zoom out"
									className="image-viewer-control"
									disabled={!zoomable || !zoomed}
									onClick={() => zoomTo(zoomStep(scale, -1, bounds))}
									type="button"
								>
									<MinusIcon aria-hidden="true" size={18} />
								</button>
								<input
									aria-label="Zoom"
									aria-valuetext={`${Math.round(scale * 100)}%`}
									className="image-viewer-slider"
									data-tooltip="Zoom"
									disabled={!zoomable}
									max={100}
									min={0}
									onChange={event => zoomTo(scaleOf(Number(event.currentTarget.value), bounds))}
									step={1}
									type="range"
									value={sliderOf(scale, bounds)}
								/>
								<button
									aria-label="Zoom in"
									className="image-viewer-control"
									disabled={!zoomable || scale >= bounds.max * 0.999}
									onClick={() => zoomTo(zoomStep(scale, 1, bounds))}
									type="button"
								>
									<PlusIcon aria-hidden="true" size={18} />
								</button>
							</span>
						</>
					)}
				</div>
				<p className="image-viewer-caption">
					{picture?.caption && picture.caption !== label && (
						<span className="image-viewer-caption-text">{picture.caption}</span>
					)}
					{many && (
						<span className="image-viewer-count" role="status">
							{index + 1} of {images.length}
						</span>
					)}
				</p>
				<div className="image-viewer-end">
					<button
						aria-label={`Download ${noun}`}
						className="image-viewer-control"
						data-image-viewer-download=""
						disabled={broken}
						onClick={() => {
							setSaid("");
							save(download.href, download.name).then(
								outcome => setSaid(outcome === "opened" ? `Opened the ${noun} in a new tab.` : ""),
								() => setSaid(`Couldn’t download ${noun}.`),
							);
						}}
						type="button"
					>
						<DownloadIcon aria-hidden="true" size={18} />
					</button>
				</div>
			</footer>
			<span aria-live="polite" className="sr-only" data-image-viewer-said="">{said}</span>
		</dialog>,
		document.body,
	);
}
