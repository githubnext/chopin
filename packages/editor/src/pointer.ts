import { useEffect } from "react";

export const COARSE_POINTER_QUERY = "(any-pointer: coarse)";
const PRIMARY_COARSE_POINTER_QUERY = "(pointer: coarse)";

export function hasCoarsePointer(
	media: (query: string) => Pick<MediaQueryList, "matches"> = matchMedia,
): boolean {
	return media(COARSE_POINTER_QUERY).matches;
}

/** Mirrors browser pointer capability into CSS so JS and touch sizing agree. */
export function usePointerCapabilities(): void {
	useEffect(() => {
		let coarse = matchMedia(COARSE_POINTER_QUERY);
		let primary = matchMedia(PRIMARY_COARSE_POINTER_QUERY);
		let root = document.documentElement;
		let update = () => {
			root.toggleAttribute("data-plan-coarse-pointer", coarse.matches);
			root.toggleAttribute("data-plan-primary-coarse-pointer", primary.matches);
		};
		update();
		coarse.addEventListener("change", update);
		primary.addEventListener("change", update);
		return () => {
			coarse.removeEventListener("change", update);
			primary.removeEventListener("change", update);
		};
	}, []);
}
