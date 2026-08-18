import type { Align } from "@chopin/dialect";

/** The shared order used by both measured rails and touch table actions. */
const ALIGNMENTS: Align[] = [null, "left", "center", "right"];

const LABELS: Record<string, string> = {
	null: "default",
	left: "left",
	center: "centre",
	right: "right",
};

export function alignmentLabel(value: Align): string {
	return LABELS[String(value ?? null)]!;
}

export function nextAlign(current: Align): Align {
	let index = ALIGNMENTS.indexOf(current ?? null);
	return ALIGNMENTS[(index + 1) % ALIGNMENTS.length] ?? null;
}
