import { useEffect, useRef } from "react";

import type { KeyboardEvent, ReactNode, RefObject } from "react";

function focusable(node: HTMLElement): HTMLElement[] {
	return [...node.querySelectorAll<HTMLElement>(
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
	)].filter(element => !element.hasAttribute("hidden"));
}

export function NavigationFocusScope(
	{
		children,
		initialFocus,
		onDismiss,
	}: {
		children: ReactNode;
		initialFocus?: RefObject<HTMLElement | null>;
		onDismiss: () => void;
	},
) {
	let scope = useRef<HTMLDivElement>(null);
	let previous = useRef<HTMLElement | undefined>(undefined);

	useEffect(() => {
		previous.current = document.activeElement instanceof HTMLElement
			? document.activeElement
			: undefined;
		let frame = requestAnimationFrame(() => {
			(initialFocus?.current ?? focusable(scope.current!)[0] ?? scope.current)?.focus();
		});
		return () => {
			cancelAnimationFrame(frame);
			if (previous.current?.isConnected) previous.current.focus();
		};
	}, [initialFocus]);

	function keyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onDismiss();
			return;
		}
		if (event.key !== "Tab") return;
		let items = focusable(event.currentTarget);
		if (items.length === 0) {
			event.preventDefault();
			event.currentTarget.focus();
			return;
		}
		let first = items[0]!;
		let last = items.at(-1)!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	return (
		<div className="navigation-focus-scope" onKeyDown={keyDown} ref={scope} tabIndex={-1}>
			{children}
		</div>
	);
}
