/**
 * The images of one message as a compact grid.
 *
 * Adapted from assistant-ui's Image gallery element, https://github.com/assistant-ui/assistant-ui
 * (`packages/ui/src/components/react/assistant-ui/elements/image-gallery.tsx` at commit f92028b4;
 * the file last changed in 9121416f), MIT, Copyright (c) 2026 AgentbaseAI Inc. See
 * THIRD_PARTY_NOTICES.
 *
 * Its standalone lane is the whole element: the `images`, `maxVisible` and `onOpen` props, up to
 * six tiles (square in the library, each the shape of its own image here) of which the last reads
 * `+N` for the rest, and a lightbox that steps through all of them. Chopin's changes: each tile is
 * the Chat image element, with its alt text under it and its actions over it; the lightbox is the
 * editor's, shared with the message's other images, and opens whether or not `onOpen` is given,
 * which is called with the index of the tile opened by its picture or its Open button; two
 * columns, or three where the message is wide enough; and no cap beyond the six tiles, since every
 * image is reachable from the lightbox.
 */

import { HiddenImage, ImageFigure, MessageImages, useImageHost } from "./image";
import { galleryTiles } from "./image-state";
import "./image.css";

import type { ChatImageData } from "./image";

export type ImageGalleryProps = {
	images: readonly ChatImageData[];
	maxVisible?: number;
	onOpen?: (index: number) => void;
};

export function ImageGallery({ images, maxVisible = 6, onOpen }: ImageGalleryProps) {
	let host = useImageHost();
	if (images.length === 0) return null;
	if (!host) {
		return (
			<MessageImages>
				<ImageGallery images={images} maxVisible={maxVisible} onOpen={onOpen} />
			</MessageImages>
		);
	}
	let { shown, more } = galleryTiles(images.length, maxVisible);
	return (
		<div className="chat-image-gallery" data-chat-image-gallery>
			<div className="chat-image-gallery-grid">
				{images.slice(0, shown).map((image, index) => (
					<ImageFigure
						host={host}
						image={image}
						key={`${index}:${image.src}`}
						more={index === shown - 1 && more ? more : undefined}
						onOpen={onOpen && (() => onOpen(index))}
						variant="tile"
					/>
				))}
				{images.slice(shown).map((image, index) => (
					<HiddenImage host={host} image={image} key={`${shown + index}:${image.src}`} />
				))}
			</div>
		</div>
	);
}
