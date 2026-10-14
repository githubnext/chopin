import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

export const COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const PRIMARY_COARSE_POINTER_QUERY = "(pointer: coarse)";
/** A phone's width in portrait, the phone class's width breakpoint. */
export const PHONE_WIDTH_QUERY = "(max-width: 600px)";
/** A phone is narrow in portrait or short in landscape. */
export const PHONE_SIZE_QUERY = `${PHONE_WIDTH_QUERY}, (max-height: 500px)`;

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

/**
 * A phone, or a window as narrow as a phone's whatever its pointer: for a layout that only fits a
 * phone's width, such as a table that would otherwise scroll sideways.
 */
export function isPhoneWidth(media: Media = matchMedia): boolean {
	return isPhone(media) || media(PHONE_WIDTH_QUERY).matches;
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

/** `isPhoneWidth`, following the window as it resizes. */
export function usePhoneWidth(): boolean {
	return useSyncExternalStore(subscribePhone, () => isPhoneWidth(), () => false);
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
