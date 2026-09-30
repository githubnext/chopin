/**
 * The people on a decision: overlapping faces, three then a count.
 *
 * Each face and the count carry a design-system tooltip (see `IconTooltip` in
 * the web app) with verbatim handles, so the native `title` is suppressed.
 */

import { Face } from "./face";

export const MAX_FACES = 3;

/** One face per person even when they are connected twice; first spelling wins. */
export function presenceSplit(
	handles: readonly string[],
	max = MAX_FACES,
): { shown: string[]; hidden: string[] } {
	let seen = new Set<string>();
	let unique: string[] = [];
	for (let handle of handles) {
		let key = handle.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(handle);
	}
	return { shown: unique.slice(0, max), hidden: unique.slice(max) };
}

export function PresenceFaces({ handles }: { handles: readonly string[] }) {
	let { shown, hidden } = presenceSplit(handles);
	if (shown.length === 0) return null;
	return (
		<span
			aria-label={`Editing this question: ${[...shown, ...hidden].join(", ")}`}
			className="presence-faces"
			role="group"
		>
			{shown.map(handle => (
				<span className="presence-face" data-tooltip={handle} data-tooltip-verbatim="" key={handle}>
					<Face handle={handle} ring="page" size={24} titled={false} />
				</span>
			))}
			{hidden.length > 0 && (
				<span
					className="presence-more"
					data-tooltip={hidden.join(", ")}
					data-tooltip-verbatim=""
				>
					+{hidden.length}
				</span>
			)}
		</span>
	);
}
