import { useLayoutEffect, useRef } from "react";

import type { KeyboardEvent, ReactNode, RefObject } from "react";

function focusable(node: HTMLElement) {
	return node.querySelectorAll<HTMLElement>(
		':is(a[href], button, input, select, textarea, [tabindex]):not(:disabled, [tabindex="-1"], [hidden])',
	);
}

function focusFirst(node: HTMLElement, initial?: HTMLElement | null) {
	(initial ?? focusable(node)[0] ?? node.querySelector<HTMLElement>('[role="dialog"]') ?? node)
		.focus();
}

export function NavigationFocusScope(
	{
		active = true,
		children,
		initialFocus,
		onDismiss,
	}: {
		active?: boolean;
		children: ReactNode;
		initialFocus?: RefObject<HTMLElement | null>;
		onDismiss: () => void;
	},
) {
	let scope = useRef<HTMLDivElement>(null);
	let focused = useRef<Element | null>(null);
	let previous = useRef<HTMLElement | null>(
		document.activeElement instanceof HTMLElement ? document.activeElement : null,
	);

	useLayoutEffect(() => {
		if (!active) return;
		let root = scope.current!;
		// Suspense replacement and disabling a pending action can blur to body
		// without a focus event. Keep the keyboard inside the still-active modal.
		let observer = new MutationObserver(() => {
			let last = focused.current;
			if (
				!last || root.closest("[inert]") || document.activeElement !== document.body
				|| (root.contains(last) && !last.matches(":disabled"))
			) return;
			focusFirst(root);
		});
		observer.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["disabled"],
		});
		focusFirst(root, initialFocus?.current);
		return () => {
			observer.disconnect();
			if (previous.current?.isConnected) previous.current.focus();
		};
	}, [active, initialFocus]);

	function keyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (!active) return;
		if (event.key === "Escape") {
			event.preventDefault();
			onDismiss();
			return;
		}
		if (event.key !== "Tab") return;
		let items = focusable(event.currentTarget);
		let first = items[0];
		let last = items[items.length - 1];
		if (!first || document.activeElement === (event.shiftKey ? first : last)) {
			event.preventDefault();
			focusFirst(event.currentTarget, event.shiftKey ? last : first);
		}
	}

	return (
		<div
			className="navigation-focus-scope"
			inert={!active}
			onFocusCapture={event => {
				focused.current = event.target;
			}}
			onBlurCapture={event => {
				if (
					event.target.isConnected && !event.target.matches(":disabled")
					&& !event.currentTarget.contains(event.relatedTarget)
				) focused.current = null;
			}}
			onKeyDown={keyDown}
			ref={scope}
			tabIndex={active ? -1 : undefined}
		>
			{children}
		</div>
	);
}
