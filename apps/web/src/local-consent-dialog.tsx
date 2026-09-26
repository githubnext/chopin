import { createPortal } from "react-dom";
import { useId, useRef } from "react";

import { NavigationFocusScope } from "./navigation-focus";
import {
	CONSENT_ACCEPT_LABEL,
	CONSENT_BODY,
	CONSENT_DECLINE_LABEL,
	CONSENT_TITLE,
} from "./local-sign-in";

/**
 * The plaintext-storage consent prompt. `role="alertdialog"` and visible
 * warning styling per issue #157; Escape, the backdrop, and "No, cancel
 * sign-in" all decline. There is no other dismissal that continues sign-in.
 */
export function LocalConsentDialog(
	{ path, onDecision }: { path: string; onDecision: (accept: boolean) => void },
) {
	let titleId = useId();
	let bodyId = useId();
	let decline = useRef<HTMLButtonElement>(null);
	let dismiss = () => onDecision(false);

	return createPortal(
		<div className="navigation-modal motion-modal is-open" role="presentation">
			<button
				aria-label={`Close ${CONSENT_TITLE}`}
				className="navigation-modal-backdrop"
				onClick={dismiss}
				type="button"
			/>
			<NavigationFocusScope initialFocus={decline} onDismiss={dismiss}>
				<div
					aria-describedby={bodyId}
					aria-labelledby={titleId}
					aria-modal="true"
					className="navigation-modal-content"
					role="alertdialog"
				>
					<div className="rounded-md border border-warning bg-warning-wash px-4 py-3">
						<h2 className="text-lg font-semibold text-warning-ink" id={titleId}>
							{CONSENT_TITLE}
						</h2>
						<div className="mt-2 space-y-2 text-sm text-warning-ink" id={bodyId}>
							{CONSENT_BODY.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
						</div>
					</div>
					<p className="mt-3 break-all rounded-md bg-warning-wash px-3 py-2 text-sm text-warning-ink">
						{path}
					</p>
					<div className="mt-5 flex flex-wrap justify-end gap-2">
						<button
							className="btn btn-md btn-secondary"
							onClick={dismiss}
							ref={decline}
							type="button"
						>
							{CONSENT_DECLINE_LABEL}
						</button>
						<button
							className="btn btn-md btn-destructive"
							onClick={() => onDecision(true)}
							type="button"
						>
							{CONSENT_ACCEPT_LABEL}
						</button>
					</div>
				</div>
			</NavigationFocusScope>
		</div>,
		document.body,
	);
}
