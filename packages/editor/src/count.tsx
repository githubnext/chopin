/**
 * A number that is worth acting on.
 *
 * Three places show one: the decisions header, a quoted span with replies on
 * it, and the overflow on a stack of faces. All three take the same petrol
 * pill. A bare number stopped the header reading as anything to act on, and a
 * grey pill said there was a number without saying it mattered.
 *
 * One treatment has a cost, and it is taken knowingly: a reply count now
 * carries the same weight as an outstanding decision. If that proves too loud
 * in use, the quote is the one to demote, not the rail.
 *
 * 20px tall and fully rounded, so a single figure is a circle and the pill only
 * stretches when the number needs the room.
 */

import type { ReactNode } from "react";

export function Count(
	{ children, ring }: {
		children: ReactNode;
		/** True where it sits in the overlapping stack, beside the faces. */
		ring?: boolean;
	},
) {
	return (
		<span
			className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-sm leading-none font-medium text-white tabular-nums ${
				ring ? "ring-2 ring-page" : ""
			}`}
		>
			{children}
		</span>
	);
}
