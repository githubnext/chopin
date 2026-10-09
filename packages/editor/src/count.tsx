/**
 * A compact count with an actionable default and a quieter secondary treatment.
 * Standard counts keep a 20px minimum footprint; control counts fit inside buttons.
 * Tabular numerals and motion opt-in apply to both.
 */

import type { ReactNode } from "react";

import "./count.css";

type CountProps =
	& {
		children: ReactNode;
		/** True only when a newly actionable count enters. */
		motion?: boolean;
		/** True where it sits in the overlapping stack, beside the faces. */
		ring?: boolean;
	}
	& (
		| {
			appearance: "control";
			selected?: boolean;
			typography?: never;
		}
		| {
			/** Quiet styling for counts that are secondary to their label. */
			appearance?: "actionable" | "quiet";
			selected?: never;
			typography?: "default" | "metadata";
		}
	);

export function Count(
	{ appearance = "actionable", children, motion, ring, selected, typography = "default" }:
		CountProps,
) {
	let shape = appearance === "control"
		? "editor-count-control rounded-sm text-xs text-text-tertiary"
		: appearance === "quiet"
		? `h-5 min-w-5 rounded-sm bg-count-quiet px-1 text-text-tertiary ${
			typography === "metadata" ? "text-2xs" : "text-xs"
		}`
		: `h-5 min-w-5 rounded-full bg-brand px-1.5 text-white ${
			typography === "metadata" ? "text-2xs" : "text-sm"
		}`;
	return (
		<span
			className={`inline-flex shrink-0 items-center justify-center leading-none font-medium tabular-nums ${shape} ${
				motion ? "editor-motion-feedback" : ""
			} ${ring ? "ring-2 ring-page" : ""}`}
			data-motion-feedback={motion ? "count" : undefined}
			data-selected={appearance === "control" && selected || undefined}
		>
			{children}
		</span>
	);
}
