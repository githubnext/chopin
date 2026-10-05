/**
 * The mark for whoever said something.
 *
 * Shape carries kind: a person is a rounded square, the agent a circle. That
 * has to hold everywhere at once, because the same person appears in a chat
 * entry, in the presence stack and in the header — drawn separately per surface
 * it becomes one person with two shapes on one screen, which is exactly how the
 * two copies this replaces came to disagree. So there is one of each here and
 * the size is the only thing a caller chooses, set by the row it sits in.
 *
 * The photograph takes the same shape as the fallback. If a loaded face were
 * round and a failed one square, the shape would report whether github.com
 * answered rather than who is speaking — and a person with a photograph would
 * be the same shape as the agent.
 *
 * Until the photograph arrives, and for good if it never does, the mark is a
 * square tinted with the person's cursor colour and carrying their initial, so a dead URL never shows the
 * browser's broken-image glyph.
 */

import { useState } from "react";

import { color } from "./cursor";

/** Retina-sharp at the rendered size. */
function photograph(handle: string, size: number): string {
	return `https://github.com/${encodeURIComponent(handle)}.png?size=${size * 2}`;
}

export type FaceProps = {
	/** Unverified, so the photograph may not exist. */
	handle: string;
	size?: number;
	/** The surface behind overlapping faces, so their cover ring does not show. */
	ring?: "ground" | "page";
	/** Set false where a design-system tooltip already names the face. */
	titled?: boolean;
	/** Set true where the name is written beside the face, so it is not read twice. */
	decorative?: boolean;
};

export const FACE_RING_CLASS = {
	ground: "ring-2 ring-ground",
	page: "ring-2 ring-page",
} as const;

export const FACE_RADIUS_CLASS = {
	small: "rounded-sm",
	regular: "rounded-md",
} as const;

/** Small faces need a smaller corner than the default. */
export function faceCorner(size: number): keyof typeof FACE_RADIUS_CLASS {
	return size <= 18 ? "small" : "regular";
}

export function Face({ decorative, handle, ring, size = 20, titled = true }: FaceProps) {
	let [failed, setFailed] = useState(false);
	let [loaded, setLoaded] = useState(false);
	let tone = color(handle);
	let edge = `${FACE_RADIUS_CLASS[faceCorner(size)]} ${ring ? FACE_RING_CLASS[ring] : ""}`;

	return (
		<span
			aria-hidden={decorative || undefined}
			aria-label={decorative ? undefined : handle}
			role={decorative ? undefined : "img"}
			className={`relative grid shrink-0 place-items-center overflow-hidden text-xs font-semibold uppercase ${edge}`}
			style={{
				width: size,
				height: size,
				background: `color-mix(in srgb, ${tone} 18%, var(--color-page))`,
				color: `color-mix(in srgb, ${tone} 80%, var(--color-text-primary))`,
			}}
			title={titled ? handle : undefined}
		>
			{!loaded && <span aria-hidden="true">{handle.slice(0, 1)}</span>}
			{!failed && (
				<img
					alt=""
					className={`absolute inset-0 size-full object-cover ${loaded ? "" : "opacity-0"}`}
					onError={() => setFailed(true)}
					onLoad={() => setLoaded(true)}
					referrerPolicy="no-referrer"
					src={photograph(handle, size)}
				/>
			)}
		</span>
	);
}

/** The agent, which has no photograph and never will. */
export function AgentFace({ ring, size = 20 }: { ring?: boolean; size?: number }) {
	return (
		<span
			aria-label="Planner"
			className={`block shrink-0 rounded-full bg-brand ${ring ? "ring-2 ring-page" : ""}`}
			role="img"
			style={{ width: size, height: size }}
			title="Planner"
		/>
	);
}
