import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

export const COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const PRIMARY_COARSE_POINTER_QUERY = "(pointer: coarse)";
/** A phone is narrow in portrait or short in landscape. */
export const PHONE_SIZE_QUERY = "(max-width: 600px), (max-height: 500px)";

type Media = (query: string) => Pick<MediaQueryList, "matches">;

export function hasCoarsePointer(media: Media = matchMedia): boolean {
	return media(COARSE_POINTER_QUERY).matches;
}

/**
 * The phone class: a primary touch pointer on a small screen. Landscape phones stay phones,
 * while tablets and touch laptops keep the wider layouts. Mirrored as `:root[data-phone]`.
 */
export function isPhone(media: Media = matchMedia): boolean {
	return media(PRIMARY_COARSE_POINTER_QUERY).matches && media(PHONE_SIZE_QUERY).matches;
}

function subscribePhone(notify: () => void): () => void {
	let queries = [PRIMARY_COARSE_POINTER_QUERY, PHONE_SIZE_QUERY].map(query => matchMedia(query));
	for (let query of queries) query.addEventListener?.("change", notify);
	// Size changes are also observed directly: emulated media lists may never fire `change`.
	window.addEventListener("resize", notify);
	return () => {
		for (let query of queries) query.removeEventListener?.("change", notify);
		window.removeEventListener("resize", notify);
	};
}

function currentPhone(): boolean {
	return isPhone();
}

export function usePhone(): boolean {
	return useSyncExternalStore(subscribePhone, currentPhone, () => false);
}

/** Mirrors browser pointer capability into CSS so JS and touch sizing agree. */
export function usePointerCapabilities(): void {
	let phone = usePhone();
	useLayoutEffect(() => {
		document.documentElement.toggleAttribute("data-phone", phone);
	}, [phone]);
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
