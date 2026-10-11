let clicked = new WeakMap<Element, DOMRect>();

/** Keep the opener's rect from the click: the root can replace it before the child lays out. */
export function rememberOriginRect(opener: Element | undefined) {
	if (opener?.isConnected) clicked.set(opener, opener.getBoundingClientRect());
}

export function openerRect(opener: Element | undefined): DOMRect | undefined {
	if (!opener) return undefined;
	return opener.isConnected ? opener.getBoundingClientRect() : clicked.get(opener);
}
