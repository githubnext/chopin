/**
 * An image in Chat, and the message-level lightbox that opens it.
 *
 * Rendered through assistant-ui's copied `Image` and `ImageGallery` elements
 * (`components/assistant-ui/elements/image.tsx` and `image-gallery.tsx`, recorded in
 * `components/sources.json` with their extension-point patches; see `docs/assistant-ui.md` and
 * `THIRD_PARTY_NOTICES.md`). Chopin's state drives them through props with none of assistant-ui's
 * runtime: measured aspect ratios hold each single image's box while pixels arrive, alt text and
 * captions stay on the page and available to assistive technology, external addresses are probed
 * without credentials or referrer before offering byte-level copy/download, and all showable images
 * of one message, and the files sent with it, share the editor's image viewer in document order.
 */

import {
	createContext,
	lazy,
	Suspense,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	ExpandIcon,
	ExternalLinkIcon,
	ImageOffIcon,
	LinkIcon,
	SparkleIcon,
} from "@chopin/icons";

import { formatBytes } from "@chopin/protocol/attachment";
import { ImagePlace } from "@chopin/editor/image-place";
import { ImageActions, ImagePreview, ImageRoot } from "@/components/assistant-ui/elements/image";

import {
	adoptedSize,
	copyLabel,
	copyLinkLabel,
	downloadLabel,
	downloadName,
	framedImage,
	frameRatio,
	imageLabel,
	imageSource,
	loadState,
	naturalSize,
	settledOnMount,
} from "./image-state";
import { useExternalRead } from "./image-read";
import { dataImageSize } from "./image-size";
import { loadLocalImage } from "./local-image";
import { copyWidth, fittedBox, placeholderOf, thumbnailUrl, VIEWER_WIDTH } from "./media/layout";
import "./image.css";

import type { ComponentProps, CSSProperties, ReactNode, SyntheticEvent } from "react";
import type { LightboxFile, LightboxItem } from "@chopin/editor/image-lightbox";
import type { ImageActionItem } from "@/components/assistant-ui/elements/image";
import type { Copied, ImageSource, Load, Settled } from "./image-state";

export type ChatImageData = {
	src: string;
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	generated?: boolean;
	mimeType?: string;
	/** What the image was before its sender's browser sent a smaller copy of it. */
	original?: { size: number; width: number; height: number };
};

const DocumentContext = createContext<string | undefined>(undefined);
export const ChatImageDocument = DocumentContext.Provider;

export type Loadable = Exclude<ImageSource, { kind: "unavailable" }>;

export type Shown = { source: Loadable; url: string; type?: string };

export type RegisteredImage = {
	data: ChatImageData;
	element: HTMLElement;
	label: string;
	order?: number;
	shown: Shown;
};

/** A file sent with a message, which the viewer shows as its text or as a card. */
export type RegisteredFile = { element: HTMLElement; order?: number; file: LightboxFile };

export type RegisteredEntry = RegisteredImage | RegisteredFile;

export type ImageHost = {
	register(id: string, entry: RegisteredEntry): () => void;
	open(id: string, opener?: HTMLElement | null): void;
};

const ImageLightbox = lazy(() =>
	import("@chopin/editor/image-lightbox").then(({ ImageLightbox }) => ({ default: ImageLightbox }))
);

const HostContext = createContext<ImageHost | undefined>(undefined);

function compareEntries(
	[, left]: [string, RegisteredEntry],
	[, right]: [string, RegisteredEntry],
): number {
	if (left.element === right.element) return (left.order ?? 0) - (right.order ?? 0);
	return left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING
		? -1
		: 1;
}

/** Who sent a message's images and when (in seconds), for the top of the viewer, as Slack's shows. */
export type ImageSender = { name: string; face: ReactNode; ts?: number };

/** What the viewer shows for one of a message's images or files. */
function viewed(entry: RegisteredEntry): LightboxItem {
	if ("file" in entry) return entry.file;
	let { data, label, shown } = entry;
	return {
		src: shown.source.kind === "hosted" ? thumbnailUrl(shown.url, VIEWER_WIDTH) : shown.url,
		// Download saves the stored file, never the copy drawn.
		original: shown.url,
		alt: label,
		name: label,
		download: downloadName(data.alt, data.src, shown.type ?? data.mimeType),
		...(data.caption ? { caption: data.caption } : {}),
		...(data.generated ? { generated: true } : {}),
		...(data.original
			? {
				note: `Shown smaller. The original was ${
					formatBytes(data.original.size)
				}, ${data.original.width} × ${data.original.height}.`,
			}
			: {}),
	};
}

export function MessageImages(
	{ children, sender }: { children: ReactNode; sender?: ImageSender },
) {
	let entries = useRef(new Map<string, RegisteredEntry>());
	let lastOpener = useRef<HTMLElement | null>(null);
	let place = useContext(ImagePlace);
	let [view, setView] = useState<{
		start: number;
		entries: Array<[string, RegisteredEntry]>;
	}>();

	useEffect(() => {
		if (view !== undefined) return;
		let opener = lastOpener.current;
		lastOpener.current = null;
		if (opener?.isConnected) opener.focus({ preventScroll: true });
	}, [view]);

	let host = useMemo<ImageHost>(() => ({
		register(id, entry) {
			entries.current.set(id, entry);
			return () => void entries.current.delete(id);
		},
		open(id, opener) {
			let ordered = [...entries.current].sort(compareEntries);
			if (ordered.length === 0) return;
			let start = Math.max(ordered.findIndex(([key]) => key === id), 0);
			lastOpener.current = opener ?? (document.activeElement as HTMLElement | null);
			setView({ start, entries: ordered });
		},
	}), []);

	return (
		<HostContext.Provider value={host}>
			{children}
			{view && (
				<Suspense fallback={null}>
					<ImageLightbox
						images={view.entries.map(([, entry]) => viewed(entry))}
						onClose={() => setView(undefined)}
						place={place}
						sender={sender && {
							name: sender.name,
							face: sender.face,
							...(sender.ts === undefined ? {} : { at: sender.ts * 1000 }),
						}}
						start={view.start}
					/>
				</Suspense>
			)}
		</HostContext.Provider>
	);
}

export function useImageHost(): ImageHost | undefined {
	return useContext(HostContext);
}

export function useImageDocument(): string | undefined {
	return useContext(DocumentContext);
}

export function pageOrigin(): string {
	return typeof location === "undefined" ? "" : location.origin;
}

function useLocalImage(source: ImageSource): { pending: boolean; type?: string; url?: string } {
	let address = source.kind === "local" ? source.url : undefined;
	let [read, setRead] = useState<{ address: string; type?: string; url?: string }>();
	useEffect(() => {
		if (address === undefined) return;
		let controller = new AbortController();
		let object: string | undefined;
		loadLocalImage(address, { base: pageOrigin(), signal: controller.signal }).then(
			blob => {
				if (controller.signal.aborted) return;
				object = URL.createObjectURL(blob);
				setRead({ address, type: blob.type, url: object });
			},
			() => {
				if (!controller.signal.aborted) setRead({ address });
			},
		);
		return () => {
			controller.abort();
			if (object) URL.revokeObjectURL(object);
		};
	}, [address]);
	let current = read?.address === address ? read : undefined;
	return { pending: address !== undefined && !current, type: current?.type, url: current?.url };
}

function useLoad(url: string | undefined, pending: boolean) {
	let image = useRef<HTMLImageElement>(null);
	let [settled, setSettled] = useState<Settled>();
	let load: Load = pending ? "loading" : url ? loadState(settled, url) : "broken";
	useLayoutEffect(() => {
		let ready = url && image.current ? settledOnMount(image.current, url) : undefined;
		if (ready) setSettled(ready);
	}, [url]);
	return {
		image,
		load,
		natural: url ? adoptedSize(settled, url) : undefined,
		onError: () => url && setSettled({ src: url, outcome: "broken" }),
		onLoad: ({ currentTarget }: SyntheticEvent<HTMLImageElement>) => {
			let size = naturalSize(currentTarget);
			if (url) setSettled({ src: url, outcome: "shown", ...size && { size } });
		},
	};
}

function useFrameImage(image: ChatImageData, source: ImageSource): ChatImageData {
	let stated = frameRatio(image.width, image.height) !== undefined;
	let written = !stated && source.kind === "data" ? source.url : undefined;
	let size = useMemo(() => written === undefined ? undefined : dataImageSize(written), [written]);
	return size ? { ...image, ...size } : image;
}

/** Slack's line above an image: its name (the alt text, or an attachment's file name). */
function ImageMeta({ image, label }: { image: ChatImageData; label: string }) {
	return (
		<span className="chat-image-meta">
			{/* The picture, or its fallback where none is drawn, already names it to a screen reader, so the visible words are hidden from it. */}
			<span aria-hidden="true" className="chat-image-alt">{label}</span>
			{image.generated && image.alt?.trim() && (
				<span className="chat-image-generated">
					<SparkleIcon aria-hidden="true" size={12} />
					Generated
				</span>
			)}
		</span>
	);
}

async function toPng(blob: Blob): Promise<Blob> {
	let bitmap = await createImageBitmap(blob);
	let canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
	bitmap.close();
	return new Promise((resolve, reject) =>
		canvas.toBlob(
			png => png ? resolve(png) : reject(new Error("The image could not be read.")),
			"image/png",
		)
	);
}

/** Browsers let a page copy PNG and little else, so any other type is redrawn as one. */
async function fetchImage(url: string): Promise<Blob> {
	let response = await fetch(url, { referrerPolicy: "no-referrer" });
	if (!response.ok) throw new Error(`The image answered ${response.status}.`);
	return response.blob();
}

async function copyImage(url: string): Promise<void> {
	if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
		throw new Error("Clipboard API is not available in this environment.");
	}
	let png = fetchImage(url).then(blob => blob.type === "image/png" ? blob : toPng(blob));
	// The item holds the promise, so the write starts inside the click that asked for it.
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function copyLink(url: string): Promise<void> {
	if (!navigator.clipboard) {
		throw new Error("Clipboard API is not available in this environment.");
	}
	await navigator.clipboard.writeText(url);
}

function save(href: string, name: string): void {
	let link = document.createElement("a");
	link.href = href;
	link.download = name;
	link.rel = "noopener";
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
}

async function downloadImage({ source, url }: Shown, name: string): Promise<void> {
	if (source.kind !== "external") return save(url, name);
	let object = URL.createObjectURL(await fetchImage(url));
	save(object, name);
	setTimeout(() => URL.revokeObjectURL(object), 40_000);
}

export function ChatImageActions(
	{ data, engaged, label, onOpen, shown }: {
		data: ChatImageData;
		engaged: boolean;
		label?: string;
		onOpen?: (opener: HTMLElement) => void;
		shown: Shown | undefined;
	},
) {
	let [copied, setCopied] = useState<Copied>("idle");
	let [saved, setSaved] = useState<Copied>("idle");
	let read = useExternalRead(
		shown?.source.kind === "external" && engaged ? shown.url : undefined,
	);
	let linked = shown?.source.kind === "external" && read !== "readable";

	useEffect(() => {
		if (copied === "idle" && saved === "idle") return;
		let timer = setTimeout(() => {
			setCopied("idle");
			setSaved("idle");
		}, 1600);
		return () => clearTimeout(timer);
	}, [copied, saved]);

	let items: ImageActionItem[] = [];
	if (onOpen) {
		items.push({
			key: "open",
			slot: "image-open",
			label: "Open image",
			icon: <ExpandIcon aria-hidden="true" size={16} />,
			onClick: () => {},
			props: {
				"aria-haspopup": "dialog",
				"data-chat-image-action": "open",
				onClick: event => onOpen(event.currentTarget as HTMLElement),
			} as ImageActionItem["props"],
		});
	}
	items.push({
		key: "copy",
		slot: "image-copy",
		label: linked ? copyLinkLabel(copied) : copyLabel(copied),
		icon: copied === "copied"
			? <CheckIcon aria-hidden="true" size={16} />
			: linked
			? <LinkIcon aria-hidden="true" size={16} />
			: <CopyIcon aria-hidden="true" size={16} />,
		onClick: () => {
			if (!shown) return;
			(linked ? copyLink(shown.url) : copyImage(shown.url)).then(
				() => setCopied("copied"),
				() => setCopied("failed"),
			);
		},
		props: { "data-chat-image-action": "copy" } as ImageActionItem["props"],
	});
	if (linked && shown) {
		items.push({
			key: "open-original",
			slot: "image-download",
			label: "Open image",
			href: shown.url,
			icon: <ExternalLinkIcon aria-hidden="true" size={16} />,
			props: {
				"data-chat-image-action": "open-original",
				rel: "noopener noreferrer",
				target: "_blank",
			} as ImageActionItem["props"],
		});
	} else {
		items.push({
			key: "download",
			slot: "image-download",
			label: downloadLabel(saved),
			icon: <DownloadIcon aria-hidden="true" size={16} />,
			onClick: () => {
				if (!shown) return;
				downloadImage(
					shown,
					downloadName(data.alt, data.src, shown.type ?? data.mimeType),
				).catch(() => setSaved("failed"));
			},
			props: { "data-chat-image-action": "download" } as ImageActionItem["props"],
		});
	}
	if (shown?.source.kind === "external") {
		items.push({
			key: "new-tab",
			slot: "image-new-tab",
			label: "Open image in a new tab",
			href: shown.url,
			icon: <ExternalLinkIcon aria-hidden="true" size={16} />,
			props: {
				"data-chat-image-action": "new-tab",
				rel: "noopener noreferrer",
				target: "_blank",
			} as ImageActionItem["props"],
		});
	}

	return (
		<>
			<ImageActions
				actions={items}
				groupProps={label ? { "aria-label": `Actions for ${label}`, role: "group" } : undefined}
			/>
			<span aria-live="polite" className="sr-only">
				{saved === "failed"
					? downloadLabel(saved)
					: copied === "idle"
					? ""
					: (linked ? copyLinkLabel : copyLabel)(copied)}
			</span>
		</>
	);
}

function useImageEntry(
	host: ImageHost,
	image: ChatImageData,
	anchor: React.RefObject<HTMLElement | null>,
	order?: number,
) {
	let id = useId();
	let documentId = useContext(DocumentContext);
	let source = imageSource(image.src, documentId, pageOrigin());
	let label = imageLabel(image.alt, image.generated);
	let local = useLocalImage(source);
	let url = source.kind === "local"
		? local.url
		: source.kind === "unavailable"
		? undefined
		: source.url;

	useLayoutEffect(() => {
		let element = anchor.current;
		if (source.kind === "unavailable" || !url || !element) return;
		return host.register(id, {
			data: image,
			element,
			label,
			order,
			shown: { source, type: local.type, url },
		});
	}, [
		host,
		anchor,
		id,
		order,
		url,
		label,
		local.type,
		image.src,
		image.alt,
		image.caption,
		image.generated,
	]);

	return { id, label, pending: local.pending, source, type: local.type, url };
}

export function screenDensity(): number {
	return typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
}

/** Slack's bounds for an image in a message: its `thumb_480` width and `thumb_360` height. */
const MESSAGE_BOUNDS = { width: 480, height: 360 };

export function SingleImage({ host, image }: { host: ImageHost; image: ChatImageData }) {
	let anchor = useRef<HTMLSpanElement>(null);
	let { id, label, pending, source, type, url } = useImageEntry(host, image, anchor);
	let { image: preview, load, natural, onError, onLoad } = useLoad(url, pending);
	let framed = framedImage(useFrameImage(image, source), natural);
	let ratio = frameRatio(framed.width, framed.height);
	let box = ratio ? fittedBox(framed.width!, framed.height!, MESSAGE_BOUNDS) : undefined;
	let [engaged, setEngaged] = useState(false);
	let placeholder = placeholderOf(source.kind === "unavailable" ? "unavailable" : "loadable", load);
	let brokenMessage = placeholder && "words" in placeholder ? placeholder.words : undefined;
	let isBroken = brokenMessage !== undefined;
	// An upload is read at Slack's thumbnail widths; any other address is drawn as it is.
	let copies = source.kind === "hosted" && url
		? thumbnailUrl(url, copyWidth(MESSAGE_BOUNDS.width, screenDensity()))
		: undefined;

	return (
		<figure
			className="chat-image"
			data-chat-image="single"
			data-generated={image.generated ? "" : undefined}
			data-load={isBroken ? "broken" : load}
			data-sized={box ? "" : undefined}
			onFocus={() => setEngaged(true)}
			onPointerEnter={() => setEngaged(true)}
			style={box
				? {
					"--image-width": framed.width,
					"--image-height": framed.height,
					"--image-box": `${box.width}px`,
				} as CSSProperties
				: undefined}
		>
			<span className="chat-image-anchor" ref={anchor} />
			<ImageMeta image={image} label={label} />
			<div className="chat-image-stage">
				<ImageRoot
					className="chat-image-frame"
					size="default"
					variant="outline"
				>
					<ImagePreview
						alt={label}
						containerProps={{
							"data-chat-image-frame": "",
							onClick: !isBroken && url && load === "shown"
								? event => {
									let opener = event.currentTarget.closest(".chat-image-stage")
										?.querySelector<HTMLElement>('[data-chat-image-action="open"]')
										?? event.currentTarget;
									opener.focus({ preventScroll: true });
									host.open(id, opener);
								}
								: undefined,
						} as ComponentProps<typeof ImagePreview>["containerProps"]}
						decoding="async"
						errorChildren={
							// The image's name is the line just above, as Slack's placeholder keeps it.


								<span aria-hidden="true" className="chat-image-error">
									<span className="chat-image-error-label">{brokenMessage}</span>
								</span>

						}
						errorProps={{
							"aria-label": `${brokenMessage}: ${label}`,
							"data-chat-image-broken": source.kind,
							role: "img",
						} as ComponentProps<typeof ImagePreview>["errorProps"]}
						fit="contain"
						loading="lazy"
						loadingProps={url ? { "aria-hidden": "true" } : { "aria-label": label, role: "img" }}
						onError={onError}
						onLoad={onLoad}
						ratio={ratio ? "custom" : "auto"}
						ref={preview}
						referrerPolicy="no-referrer"
						src={source.kind === "unavailable" || !url ? undefined : copies ?? url}
						status={isBroken ? "error" : load === "shown" ? "loaded" : "loading"}
					/>
				</ImageRoot>
				{!isBroken && (
					<div
						aria-hidden={load !== "shown" || undefined}
						className="chat-image-actions-slot"
						inert={load !== "shown"}
						onClick={event => event.stopPropagation()}
					>
						<ChatImageActions
							data={image}
							engaged={engaged}
							label={label}
							onOpen={opener => host.open(id, opener)}
							shown={url && source.kind !== "unavailable" ? { source, type, url } : undefined}
						/>
					</div>
				)}
			</div>
			{image.caption && <figcaption className="chat-image-text">{image.caption}</figcaption>}
		</figure>
	);
}

export function RefusedImage({ reason }: { reason: string }) {
	return (
		<p aria-label={reason} className="chat-image-refused" data-chat-image-refused role="img">
			<ImageOffIcon aria-hidden="true" size={16} />
			<span>{reason}</span>
		</p>
	);
}

export function ChatImage({ image }: { image: ChatImageData }) {
	let host = useImageHost();
	return host
		? <SingleImage host={host} image={image} />
		: (
			<MessageImages>
				<ChatImage image={image} />
			</MessageImages>
		);
}
