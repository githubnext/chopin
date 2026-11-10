/**
 * An image in Chat, and the lightbox that opens it.
 *
 * Adapted from assistant-ui's Image element, https://github.com/assistant-ui/assistant-ui
 * (`packages/ui/src/components/react/assistant-ui/elements/image.tsx` at commit f92028b4; the file
 * last changed in 3b6591b1), MIT, Copyright (c) 2026 AgentbaseAI Inc. See THIRD_PARTY_NOTICES.
 *
 * Only its standalone lane is taken, driven by props: `ImageRoot`, `ImagePreview`, `ImageActions`
 * and the copy and download helpers (its `ImageFilename` is `ImageCaption`). Nothing needs
 * assistant-ui's runtime. Chopin's changes: Chopin's tokens, icons and buttons in place of
 * Tailwind's palette, lucide and `cva`; a frame that holds the image's own shape while it loads; the
 * alt text always shown; a "Generated" label; the one lightbox of the editor in place of the zoom
 * overlay; a copy that writes PNG, the one image type a browser lets a page copy; and actions that
 * are only offered for an image that loaded.
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
	ImageIcon,
	ImageOffIcon,
	SparkleIcon,
} from "@chopin/icons";

import {
	copyLabel,
	downloadLabel,
	downloadName,
	frameRatio,
	imageLabel,
	imageSource,
	loadState,
	settledOnMount,
} from "./image-state";
import { loadLocalImage } from "./local-image";
import "./image.css";

import type { ReactNode } from "react";
import type { LightboxImage } from "@chopin/editor/image-lightbox";
import type { Copied, ImageSource, Load, Settled } from "./image-state";

const Lightbox = lazy(() =>
	import("@chopin/editor/image-lightbox").then(({ ImageLightbox }) => ({ default: ImageLightbox }))
);

export type ChatImageData = {
	src: string;
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	generated?: boolean;
};

const DocumentContext = createContext<string | undefined>(undefined);
export const ChatImageDocument = DocumentContext.Provider;

type Loadable = Exclude<ImageSource, { kind: "unavailable" }>;

type Shown = { source: Loadable; url: string; type?: string };

type Entry = Shown & { data: ChatImageData; element: HTMLElement; image: LightboxImage };

type Host = {
	register(id: string, entry: Entry): () => void;
	open(id: string): void;
};

const HostContext = createContext<Host | undefined>(undefined);

export function MessageImages({ children }: { children: ReactNode }) {
	let entries = useRef(new Map<string, Entry>());
	let [view, setView] = useState<{ entries: Entry[]; start: number }>();
	let host = useMemo<Host>(() => ({
		register(id, entry) {
			entries.current.set(id, entry);
			return () => void entries.current.delete(id);
		},
		open(id) {
			let ordered = [...entries.current].sort(([, a], [, b]) =>
				a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
			);
			setView({
				entries: ordered.map(([, entry]) => entry),
				start: Math.max(0, ordered.findIndex(([key]) => key === id)),
			});
		},
	}), []);
	return (
		<HostContext.Provider value={host}>
			{children}
			{view && (
				<Suspense fallback={null}>
					<Lightbox
						actions={(_, index) => {
							let { data, source, type, url } = view.entries[index]!;
							return (
								<ImageButtons
									compact={false}
									data={data}
									key={index}
									inLightbox
									shown={{ source, type, url }}
								/>
							);
						}}
						images={view.entries.map(entry => entry.image)}
						onClose={() => setView(undefined)}
						start={view.start}
					/>
				</Suspense>
			)}
		</HostContext.Provider>
	);
}

export function useImageHost(): Host | undefined {
	return useContext(HostContext);
}

function pageOrigin(): string {
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
		onError: () => url && setSettled({ src: url, outcome: "broken" }),
		onLoad: () => url && setSettled({ src: url, outcome: "shown" }),
	};
}

function ImageRoot(
	{ children, image, load, variant }: {
		children: ReactNode;
		image: ChatImageData;
		load: Load;
		variant: "single" | "tile";
	},
) {
	let ratio = frameRatio(image.width, image.height);
	return (
		<figure
			className="chat-image"
			data-chat-image={variant}
			data-generated={image.generated ? "" : undefined}
			data-load={load}
			data-sized={ratio ? "" : undefined}
			style={ratio
				? { "--image-width": image.width, "--image-height": image.height } as React.CSSProperties
				: undefined}
		>
			{children}
		</figure>
	);
}

function ImagePreview(
	{ label, load, onError, onLoad, preview, source, url }: {
		label: string;
		load: Load;
		onError: () => void;
		onLoad: () => void;
		preview: React.RefObject<HTMLImageElement | null>;
		source: ImageSource;
		url: string | undefined;
	},
) {
	if (source.kind === "unavailable" || load === "broken") {
		return (
			<span className="chat-image-broken" data-chat-image-broken={source.kind}>
				<ImageOffIcon aria-hidden="true" size={24} />
				<span>
					{source.kind === "unavailable" ? "Image can’t be shown" : "Couldn’t load image"}
				</span>
			</span>
		);
	}
	return (
		<>
			{load === "loading" && (
				<span aria-hidden="true" className="chat-image-placeholder">
					<ImageIcon size={24} />
				</span>
			)}
			{url && (
				<img
					alt={label}
					className="chat-image-preview"
					decoding="async"
					loading="lazy"
					onError={onError}
					onLoad={onLoad}
					ref={preview}
					referrerPolicy="no-referrer"
					src={url}
				/>
			)}
		</>
	);
}

function ImageCaption({ image, label }: { image: ChatImageData; label: string }) {
	return (
		<figcaption className="chat-image-caption">
			{/* The img already names the picture to a screen reader, so the visible words are hidden from it. */}
			<span aria-hidden="true" className="chat-image-alt">{label}</span>
			{image.generated && image.alt?.trim() && (
				<span className="chat-image-generated">
					<SparkleIcon aria-hidden="true" size={12} />
					Generated
				</span>
			)}
			{image.caption && <span className="chat-image-text">{image.caption}</span>}
		</figcaption>
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

function ImageButtons(
	{ compact, data, inLightbox = false, shown }: {
		compact: boolean;
		data: ChatImageData;
		inLightbox?: boolean;
		shown: Shown;
	},
) {
	let [copied, setCopied] = useState<Copied>("idle");
	let [saved, setSaved] = useState<Copied>("idle");
	useEffect(() => {
		if (copied === "idle" && saved === "idle") return;
		let timer = setTimeout(() => {
			setCopied("idle");
			setSaved("idle");
		}, 1600);
		return () => clearTimeout(timer);
	}, [copied, saved]);
	return (
		<>
			<button
				aria-label={copyLabel(copied)}
				className={`btn ${compact ? "btn-icon-xs" : "btn-icon"} ${
					inLightbox ? "btn-secondary" : "btn-outline"
				}`}
				data-chat-image-action="copy"
				onClick={() =>
					copyImage(shown.url).then(() => setCopied("copied"), () => setCopied("failed"))}
				type="button"
			>
				{copied === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon />}
			</button>
			<button
				aria-label={downloadLabel(saved)}
				className={`btn ${compact ? "btn-icon-xs" : "btn-icon"} ${
					inLightbox ? "btn-secondary" : "btn-outline"
				}`}
				data-chat-image-action="download"
				onClick={() =>
					downloadImage(shown, downloadName(data.alt, data.src, shown.type)).catch(() =>
						setSaved("failed")
					)}
				type="button"
			>
				<DownloadIcon aria-hidden="true" />
			</button>
			{shown.source.kind === "external" && (
				<a
					aria-label="Open image in a new tab"
					className={`btn ${compact ? "btn-icon-xs" : "btn-icon"} ${
						inLightbox ? "btn-secondary" : "btn-outline"
					}`}
					data-chat-image-action="new-tab"
					href={shown.url}
					rel="noopener noreferrer"
					target="_blank"
				>
					<ExternalLinkIcon aria-hidden="true" />
				</a>
			)}
			<span aria-live="polite" className="sr-only">
				{saved === "failed" ? downloadLabel(saved) : copied === "idle" ? "" : copyLabel(copied)}
			</span>
		</>
	);
}

function ImageActions(
	{ compact, data, label, onOpen, shown }: {
		compact: boolean;
		data: ChatImageData;
		label: string;
		onOpen: () => void;
		shown: Shown;
	},
) {
	return (
		<div
			aria-label={`Actions for ${label}`}
			className="chat-image-actions"
			onClick={event => event.stopPropagation()}
			role="group"
		>
			<button
				aria-haspopup="dialog"
				aria-label="Open image"
				className={`btn ${compact ? "btn-icon-xs" : "btn-icon"} btn-outline`}
				data-chat-image-action="open"
				onClick={onOpen}
				type="button"
			>
				<ExpandIcon aria-hidden="true" />
			</button>
			<ImageButtons compact={compact} data={data} shown={shown} />
		</div>
	);
}

function useImageEntry(
	host: Host,
	image: ChatImageData,
	anchor: React.RefObject<HTMLElement | null>,
) {
	let id = useId();
	let document = useContext(DocumentContext);
	let source = imageSource(image.src, document, pageOrigin());
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
			image: { src: url, alt: label, caption: image.caption, generated: image.generated },
			source,
			type: local.type,
			url,
		});
	}, [host, anchor, id, url, label, image.src, image.alt, image.caption, image.generated]);

	return { id, label, pending: local.pending, source, type: local.type, url };
}

export function HiddenImage({ host, image }: { host: Host; image: ChatImageData }) {
	let anchor = useRef<HTMLSpanElement>(null);
	useImageEntry(host, image, anchor);
	return <span aria-hidden="true" hidden ref={anchor} />;
}

export function ImageFigure(
	{ host, image, more, variant }: {
		host: Host;
		image: ChatImageData;
		more?: number;
		variant: "single" | "tile";
	},
) {
	let anchor = useRef<HTMLSpanElement>(null);
	let { id, label, pending, source, type, url } = useImageEntry(host, image, anchor);
	let { image: preview, load, onError, onLoad } = useLoad(url, pending);
	let open = () => host.open(id);
	return (
		<ImageRoot image={image} load={load} variant={variant}>
			<span className="chat-image-anchor" ref={anchor} />
			<div
				className="chat-image-frame"
				data-chat-image-frame
				onClick={url && load === "shown"
					? event => {
						// Focus the Open action so the lightbox gives focus back to it.
						event.currentTarget.querySelector<HTMLElement>('[data-chat-image-action="open"]')
							?.focus({ preventScroll: true });
						open();
					}
					: undefined}
			>
				<ImagePreview
					label={label}
					load={load}
					onError={onError}
					onLoad={onLoad}
					preview={preview}
					source={source}
					url={url}
				/>
				{more ? <span aria-hidden="true" className="chat-image-more">+{more}</span> : null}
				{source.kind !== "unavailable" && url && load === "shown" && (
					<ImageActions
						compact={variant === "tile"}
						data={image}
						label={label}
						onOpen={open}
						shown={{ source, type, url }}
					/>
				)}
			</div>
			<ImageCaption image={image} label={label} />
		</ImageRoot>
	);
}

export function ChatImage({ image }: { image: ChatImageData }) {
	let host = useImageHost();
	return host
		? <ImageFigure host={host} image={image} variant="single" />
		: (
			<MessageImages>
				<ChatImage image={image} />
			</MessageImages>
		);
}
