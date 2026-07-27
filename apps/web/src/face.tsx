/**
 * A person.
 *
 * The handle is unverified, so the avatar may not exist. Initials in the
 * person's own colour are a better answer than a broken image, and keep the
 * identity legible either way.
 */

import { useState } from "react";
import { color } from "@chopin/editor";

export function Face({ handle, size = 24 }: { handle: string; size?: number }) {
	let [failed, setFailed] = useState(false);
	let style = { width: size, height: size };

	if (failed) {
		return (
			<span
				className="grid place-items-center rounded-full font-semibold text-white uppercase"
				style={{ ...style, background: color(handle), fontSize: size * 0.4 }}
				title={handle}
			>
				{handle.slice(0, 2)}
			</span>
		);
	}

	return (
		<img
			alt={handle}
			className="rounded-full bg-muted"
			onError={() => setFailed(true)}
			referrerPolicy="no-referrer"
			src={`https://github.com/${encodeURIComponent(handle)}.png?size=${size * 2}`}
			style={style}
			title={handle}
		/>
	);
}
