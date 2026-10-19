import type { ReactNode } from "react";

export function letter(index: number): string {
	return String.fromCharCode(65 + index);
}

/** A line-tall slot, so the tile centres on the label's first line, not the whole row. */
export function Key({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden="true" className="question-key">
			<span>{children}</span>
		</span>
	);
}
