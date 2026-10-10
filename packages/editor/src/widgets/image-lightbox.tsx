import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CloseIcon, MinusIcon, PlusIcon } from "@chopin/icons";

export function ImageLightbox(
	{ src, alt, onClose }: { src: string; alt: string; onClose: () => void },
) {
	let dialog = useRef<HTMLDialogElement>(null);
	let close = useRef<HTMLButtonElement>(null);
	let [zoomed, setZoomed] = useState(false);
	let [naturalWidth, setNaturalWidth] = useState<number>();

	useLayoutEffect(() => {
		let element = dialog.current;
		element?.showModal();
		close.current?.focus();
		return () => {
			if (element?.open) element.close();
		};
	}, []);

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
				<img
					alt={alt}
					src={src}
					referrerPolicy="no-referrer"
					style={{ width: zoomed && naturalWidth ? naturalWidth * 2 : undefined }}
					onLoad={event => setNaturalWidth(event.currentTarget.naturalWidth)}
				/>
			</div>
		</dialog>,
		document.body,
	);
}
