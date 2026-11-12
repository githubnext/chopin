import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, WarningIcon } from "@chopin/icons";

import "./code-copy.css";

/** How long the button shows its check or warning after a copy attempt, as Chat's does. */
const COPIED_MS = 3000;

/**
 * A code block's Copy code, the same control as a Chat code block's: _Copy code_, then for three
 * seconds _Copied_ with a check, or _Couldn't copy_ with a warning glyph in the danger icon role
 * where a page has no clipboard or the browser refuses the write. It copies the block's source as
 * written, whoever reads it, so a reader who cannot edit can copy too.
 */
export function CopyCode({ source }: { source: string }) {
	let [outcome, setOutcome] = useState<"copied" | "failed">();
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	let copy = () => {
		if (outcome === "copied") return;
		let done = (next: "copied" | "failed") => {
			setOutcome(next);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setOutcome(undefined), COPIED_MS);
		};
		try {
			if (!navigator.clipboard) {
				done("failed");
				return;
			}
			navigator.clipboard.writeText(source).then(() => done("copied"), () => done("failed"));
		} catch {
			done("failed");
		}
	};
	let label = outcome === "copied"
		? "Copied"
		: outcome === "failed"
		? "Couldn't copy"
		: "Copy code";
	return (
		<button
			type="button"
			onClick={copy}
			// As the source toggle: a click must not drop a caret into the source first.
			onMouseDown={event => event.preventDefault()}
			aria-label={label}
			className="plan-code-copy btn btn-icon btn-ghost"
			data-tooltip={label}
		>
			{outcome === "copied"
				? <CheckIcon aria-hidden="true" size={16} />
				: outcome === "failed"
				? <WarningIcon aria-hidden="true" className="icon-danger" size={16} />
				: <CopyIcon aria-hidden="true" size={16} />}
		</button>
	);
}
