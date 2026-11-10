import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronIcon, CloseIcon, ImageOffIcon, MinusIcon, PlusIcon } from "@chopin/icons";

import { arrowStep, stepImage, wrapTab } from "./image-lightbox-state";

export type LightboxImage = {
	src: string;
	/** Shown under the image and used as its text alternative; empty for a decorative image. */
	alt: string;
	caption?: string;
	/** The Planner or its harness made it. */
	generated?: boolean;
};

const FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/**
 * A full-screen preview of one image, or of the images of one message with their own arrows,
 * Previous and Next. It traps focus and gives it back to the control that opened it.
 */
export function ImageLightbox(
	{ images, onClose, start = 0 }: {
		images: readonly LightboxImage[];
		onClose: () => void;
		start?: number;
	},
) {
	let dialog = useRef<HTMLDialogElement>(null);
	let close = useRef<HTMLButtonElement>(null);
	let previous = useRef<HTMLButtonElement>(null);
	let next = useRef<HTMLButtonElement>(null);
	let [index, setIndex] = useState(() => stepImage(start, 0, images.length));
	let [zoomed, setZoomed] = useState(false);
	let [naturalWidth, setNaturalWidth] = useState<number>();
	let [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
	let image = images[index];
	let many = images.length > 1;
	let broken = image ? failed.has(image.src) : false;

	useLayoutEffect(() => {
		let element = dialog.current;
		let opener = document.activeElement;
		element?.showModal();
		close.current?.focus();
		return () => {
			if (element?.open) element.close();
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	let show = (delta: -1 | 1) => {
		let to = stepImage(index, delta, images.length);
		if (to === index) return;
		// The button that is about to be disabled cannot keep focus, so the other one takes it.
		if (to === 0 && document.activeElement === previous.current) next.current?.focus();
		else if (to === images.length - 1 && document.activeElement === next.current) {
			previous.current?.focus();
		}
		setIndex(to);
		setZoomed(false);
		setNaturalWidth(undefined);
	};

	// The arrows and Tab are read before anything else on the page can, and only while open.
	let latest = useRef(show);
	latest.current = show;
	useEffect(() => {
		let onKeyDown = (event: KeyboardEvent) => {
			let step = arrowStep(event.key);
			if (step && !event.altKey && !event.ctrlKey && !event.metaKey) {
				event.preventDefault();
				latest.current(step);
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

	if (!image) return null;
	let text = image.alt || image.caption || image.generated;

	return createPortal(
		<dialog
			ref={dialog}
			aria-label="Image preview"
			className="plan-image-lightbox"
			data-focus-boundary=""
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
			onClick={event => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="plan-image-lightbox-toolbar">
				<button
					type="button"
					className="btn btn-icon btn-secondary"
					aria-label={zoomed ? "Zoom out" : "Zoom in"}
					disabled={broken}
					onClick={() => setZoomed(!zoomed)}
				>
					{zoomed ? <MinusIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
				</button>
				<button
					ref={close}
					type="button"
					className="btn btn-icon btn-secondary"
					aria-label="Close image preview"
					onClick={onClose}
				>
					<CloseIcon aria-hidden="true" />
				</button>
			</div>
			<div
				className="plan-image-lightbox-scroll"
				data-zoomed={zoomed ? "" : undefined}
				onClick={event => {
					if (event.target === event.currentTarget) onClose();
				}}
			>
				{broken
					? (
						<div
							className="plan-image-lightbox-broken"
							role="img"
							aria-label={image.alt || "Image"}
						>
							<ImageOffIcon aria-hidden="true" size={24} />
							<span>This image could not be loaded.</span>
						</div>
					)
					: (
						<img
							alt={image.alt}
							key={image.src}
							src={image.src}
							referrerPolicy="no-referrer"
							style={{ width: zoomed && naturalWidth ? naturalWidth * 2 : undefined }}
							onError={() => setFailed(new Set(failed).add(image.src))}
							onLoad={event => setNaturalWidth(event.currentTarget.naturalWidth)}
						/>
					)}
			</div>
			{(text || many) && (
				<div className="plan-image-lightbox-footer">
					{many && (
						<button
							ref={previous}
							type="button"
							className="btn btn-icon btn-secondary"
							aria-label="Previous image"
							disabled={index === 0}
							onClick={() => show(-1)}
						>
							<ChevronIcon aria-hidden="true" className="rotate-180" />
						</button>
					)}
					<div className="plan-image-lightbox-text">
						{(image.alt || image.generated) && (
							<p className="plan-image-lightbox-alt">
								{image.alt}
								{image.generated && (
									<span className="plan-image-lightbox-generated">Generated</span>
								)}
							</p>
						)}
						{image.caption && <p className="plan-image-lightbox-caption">{image.caption}</p>}
					</div>
					{many && (
						<span className="plan-image-lightbox-count" role="status">
							<span className="sr-only">Image</span> {index + 1} of {images.length}
						</span>
					)}
					{many && (
						<button
							ref={next}
							type="button"
							className="btn btn-icon btn-secondary"
							aria-label="Next image"
							disabled={index === images.length - 1}
							onClick={() => show(1)}
						>
							<ChevronIcon aria-hidden="true" />
						</button>
					)}
				</div>
			)}
		</dialog>,
		document.body,
	);
}
