import { useEffect } from "react";

import { useNavigationDocument } from "./navigation-shell";

/**
 * Tells the navigation shell, for as long as `speaking` is true and this component stays, that the
 * connection banner is telling a lost connection, so the shell does not tell the same loss again at
 * the top of the page (see `navigation-failure.ts`). One call is one banner: a document and its open
 * child, each with a banner, count separately. Outside a shell nothing listens.
 */
export function useConnectionSpeaking(speaking: boolean): void {
	let { setBanners } = useNavigationDocument();
	useEffect(() => {
		if (!speaking || !setBanners) return;
		setBanners(count => count + 1);
		return () => setBanners(count => count - 1);
	}, [speaking, setBanners]);
}
