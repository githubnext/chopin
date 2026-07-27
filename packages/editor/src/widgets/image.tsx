/**
 * Images.
 *
 * A plan references an image by absolute URL, so rendering one is an `<img>`
 * and nothing more. Referrers are suppressed because plan content is written
 * by an agent as well as by people: loading it should not tell a third party
 * where the request came from.
 */

import { useState } from "react";

import type { ImageNode } from "@chopin/dialect";

function Image({ alt, src }: { alt: string; src: string }) {
	let [failed, setFailed] = useState(false);

	if (failed) {
		return (
			<span className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
				Image unavailable
			</span>
		);
	}

	return (
		<img
			// An omitted alt marks the image decorative, so screen readers skip it.
			alt={alt}
			aria-hidden={alt ? undefined : true}
			className="plan-image"
			loading="lazy"
			onError={() => setFailed(true)}
			referrerPolicy="no-referrer"
			src={src}
		/>
	);
}

export function renderImage(node: ImageNode): unknown {
	return <Image alt={node.getAlt()} src={node.getSrc()} />;
}
