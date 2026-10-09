/** Keyboard hints in the vocabulary of the reader's platform. */

export function isApplePlatform(
	nav: { platform?: string; userAgentData?: { platform?: string } } | undefined =
		typeof navigator === "undefined" ? undefined : navigator,
): boolean {
	let platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/** `shortcut("B")` is `⌘B` on Apple platforms and `Ctrl+B` elsewhere. */
export function shortcut(key: string, options: { shift?: boolean; apple?: boolean } = {}): string {
	let apple = options.apple ?? isApplePlatform();
	if (apple) return `⌘${options.shift ? "⇧" : ""}${key}`;
	return `Ctrl+${options.shift ? "Shift+" : ""}${key}`;
}
