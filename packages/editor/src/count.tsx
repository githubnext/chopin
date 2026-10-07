/**
 * A compact count with an actionable default and a quieter secondary treatment.
 * Both keep a 20px minimum footprint and tabular numerals; motion remains opt-in.
 */

import type { ReactNode } from "react";

export function Count(
	{ appearance = "actionable", children, motion, ring }: {
		children: ReactNode;
		/** Quiet styling for counts that are secondary to their label. */
		appearance?: "actionable" | "quiet";
		/** True only when a newly actionable count enters. */
		motion?: boolean;
		/** True where it sits in the overlapping stack, beside the faces. */
		ring?: boolean;
	},
) {
	return (
		<span
			className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center leading-none font-medium tabular-nums ${
				appearance === "quiet"
					? "rounded-sm bg-inset px-1 text-xs text-text-tertiary"
					: "rounded-full bg-brand px-1.5 text-sm text-white"
			} ${motion ? "editor-motion-feedback" : ""} ${ring ? "ring-2 ring-page" : ""}`}
			data-motion-feedback={motion ? "count" : undefined}
		>
			{children}
		</span>
	);
}
