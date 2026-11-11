/**
 * The images of one message as a compact grid, rendered through assistant-ui's copied
 * `ImageGallery` element (`components/assistant-ui/elements/image-gallery.tsx`, recorded in
 * `components/sources.json` with `image-gallery.tsx.patch`; see `docs/assistant-ui.md` and
 * `THIRD_PARTY_NOTICES.md`).
 *
 * The tiles are `ImageGallery`'s own buttons, laid out the way Slack lays out a message's images
 * (`image.css`, by `data-shape`): two side by side, three as one tall beside two stacked, four as
 * two rows of two with `+N` on the last when more follow. Inline refusal lines stand where a turn's
 * image could not be shown, and `ImageGallery`'s `<Dialog>` is the message's viewer.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ImageGallery as GalleryElement } from "@/components/assistant-ui/elements/image-gallery";

import {
	MessageImages,
	pageOrigin,
	RefusedImage,
	screenDensity,
	useImageDocument,
	useImageHost,
} from "./image";
import { galleryItems, imageLabel, imageSource } from "./image-state";
import { loadLocalImage } from "./local-image";
import { copyWidth, GALLERY_MAX_VISIBLE, galleryShape, thumbnailUrl } from "./media/layout";
import "./image.css";

import type { GalleryImage } from "@/components/assistant-ui/elements/image-gallery";
import type { ChatImageData, ImageHost } from "./image";
import type { Load } from "./image-state";

export type ImageGalleryProps = {
	images: readonly ChatImageData[];
	refused?: ReadonlyArray<{ before: number; reason: string }>;
	maxVisible?: number;
	onOpen?: (index: number) => void;
};

type LocalResult = { url?: string; type?: string; failed?: boolean };

function GalleryWithHost(
	{ host, images, maxVisible = GALLERY_MAX_VISIBLE, onOpen, refused }: ImageGalleryProps & {
		host: ImageHost;
	},
) {
	let galleryId = useId();
	let documentId = useImageDocument();
	let anchor = useRef<HTMLDivElement>(null);
	let [locals, setLocals] = useState<Record<string, LocalResult>>({});
	let [settled, setSettled] = useState<Record<string, "shown" | "broken">>({});

	let sources = useMemo(
		() =>
			images.map(image => ({
				image,
				label: imageLabel(image.alt, image.generated),
				source: imageSource(image.src, documentId, pageOrigin()),
			})),
		[images, documentId],
	);

	let localKey = sources.map(({ source }, index) =>
		source.kind === "local" ? `${index}:${source.url}` : ""
	).join("\n");

	useEffect(() => {
		let controller = new AbortController();
		let revokes: string[] = [];
		for (let [index, { source }] of sources.entries()) {
			if (source.kind !== "local") continue;
			let key = `${index}:${source.url}`;
			loadLocalImage(source.url, { base: pageOrigin(), signal: controller.signal }).then(
				blob => {
					if (controller.signal.aborted) return;
					let object = URL.createObjectURL(blob);
					revokes.push(object);
					setLocals(current => ({ ...current, [key]: { type: blob.type, url: object } }));
				},
				() => {
					if (!controller.signal.aborted) {
						setLocals(current => ({ ...current, [key]: { failed: true } }));
					}
				},
			);
		}
		return () => {
			controller.abort();
			for (let object of revokes) URL.revokeObjectURL(object);
		};
	}, [localKey]);

	let resolved = sources.map(({ image, label, source }, index) => {
		let key = `${index}:${image.src}`;
		let local = source.kind === "local" ? locals[`${index}:${source.url}`] : undefined;
		let pending = source.kind === "local" && !local;
		let url = source.kind === "local"
			? local?.url
			: source.kind === "unavailable"
			? undefined
			: source.url;
		let outcome = settled[key];
		let failed = source.kind === "unavailable" || Boolean(local?.failed) || outcome === "broken";
		let load: Load = failed ? "broken" : outcome === "shown" ? "shown" : "loading";
		return {
			entryId: `${galleryId}:${index}`,
			failed,
			image,
			index,
			key,
			label,
			load,
			pending,
			source,
			type: local?.type,
			url,
		};
	});

	let registrationKey = resolved.map(item =>
		`${item.entryId}:${item.failed ? "x" : item.url ?? ""}:${item.label}:${
			item.image.caption ?? ""
		}:${item.image.generated ? 1 : 0}`
	).join("\n");

	useLayoutEffect(() => {
		let element = anchor.current;
		if (!element) return;
		let cleanups = resolved.flatMap(item => {
			if (item.failed || item.source.kind === "unavailable" || !item.url) return [];
			return [
				host.register(item.entryId, {
					data: item.image,
					element,
					label: item.label,
					order: item.index,
					shown: { source: item.source, type: item.type, url: item.url },
				}),
			];
		});
		return () => {
			for (let cleanup of cleanups) cleanup();
		};
	}, [host, registrationKey]);

	let mark = (key: string, next: "shown" | "broken") => {
		setSettled(current => current[key] === next ? current : { ...current, [key]: next });
	};

	let galleryImages: GalleryImage[] = resolved.map(item => {
		let brokenMessage = item.source.kind === "unavailable"
			? "Image can’t be shown"
			: "Couldn’t load image";
		// An upload is read at Slack's thumbnail widths; any other address is drawn as it is.
		let copies = item.source.kind === "hosted" && item.url && !item.failed;
		return {
			id: item.entryId,
			src: item.failed || !item.url
				? ""
				: copies
				? thumbnailUrl(item.url, copyWidth(240, screenDensity()))
				: item.url,
			alt: item.label,
			caption: item.image.caption,
			source: item.image.generated ? { label: "Generated" } : undefined,
			failed: item.failed,
			failedLabel: item.failed ? `${brokenMessage}: ${item.label}` : undefined,
			failedChildren: item.failed
				? (
					<span aria-hidden="true" className="chat-image-tile-error">
						<span>{brokenMessage}</span>
						<span className="chat-image-tile-error-alt">{item.label}</span>
					</span>
				)
				: undefined,
			pending: item.pending,
			tileProps: {
				"data-chat-image": "tile",
				"data-load": item.load,
				...(item.failed ? { "data-chat-image-broken": item.source.kind } : {}),
				...(item.pending ? { "aria-label": item.label, role: "img" } : {}),
			} as GalleryImage["tileProps"],
			imgProps: {
				decoding: "async",
				referrerPolicy: "no-referrer",
				onLoad: () => mark(item.key, "shown"),
				onError: () => mark(item.key, "broken"),
				ref: node => {
					if (node?.complete) mark(item.key, node.naturalWidth > 0 ? "shown" : "broken");
				},
			},
		};
	});

	let refusalsByBefore = useMemo(() => {
		let grouped = new Map<number, string[]>();
		if (!refused?.length) return grouped;
		let at = 0;
		for (let item of galleryItems(images.length, refused, maxVisible)) {
			if (item.kind === "image") at = item.index + 1;
			else grouped.set(at, [...(grouped.get(at) ?? []), item.reason]);
		}
		return grouped;
	}, [images.length, refused, maxVisible]);

	return (
		<GalleryElement
			between={refused?.length
				? beforeIndex =>
					refusalsByBefore.get(beforeIndex)?.map((reason, position) => (
						<RefusedImage key={`refused:${beforeIndex}:${position}`} reason={reason} />
					))
				: undefined}
			data-chat-image-gallery=""
			data-shape={galleryShape(images.length).shape}
			images={galleryImages}
			maxVisible={maxVisible}
			onTileOpen={(tileId, trigger) => {
				let index = Number(tileId.slice(galleryId.length + 1));
				host.open(tileId, trigger);
				onOpen?.(index);
			}}
			ref={anchor}
		/>
	);
}

export function ImageGallery(
	{ images, maxVisible = GALLERY_MAX_VISIBLE, onOpen, refused }: ImageGalleryProps,
) {
	let host = useImageHost();
	if (images.length === 0 && !refused?.length) return null;
	if (!host) {
		return (
			<MessageImages>
				<ImageGallery images={images} maxVisible={maxVisible} onOpen={onOpen} refused={refused} />
			</MessageImages>
		);
	}
	return (
		<GalleryWithHost
			host={host}
			images={images}
			maxVisible={maxVisible}
			onOpen={onOpen}
			refused={refused}
		/>
	);
}
