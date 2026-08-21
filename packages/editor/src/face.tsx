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
 * No lettering. Initials were 8px inside a 20px mark and the scale now stops at
 * 13px, so they either sat off the scale or the mark grew to 28px and took that
 * width from every message in the rail. Identity rests on the photograph, the
 * shape, the account colour and the name — which is beside the mark everywhere
 * except the presence stack, where hovering is the only way to tell two people
 * on neighbouring account colours apart.
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
};

export const FACE_RING_CLASS = {
	ground: "ring-2 ring-ground",
	page: "ring-2 ring-page",
} as const;

export function Face({ handle, ring, size = 20 }: FaceProps) {
	let [failed, setFailed] = useState(false);
	let edge = `shrink-0 rounded-md ${ring ? FACE_RING_CLASS[ring] : ""}`;
	let box = { width: size, height: size };

	if (failed) {
		return (
			<span
				aria-label={handle}
				className={`block ${edge}`}
				role="img"
				style={{ ...box, background: color(handle) }}
				title={handle}
			/>
		);
	}

	return (
		<img
			alt={handle}
			className={`block bg-control ${edge}`}
			onError={() => setFailed(true)}
			referrerPolicy="no-referrer"
			src={photograph(handle, size)}
			style={box}
			title={handle}
		/>
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
