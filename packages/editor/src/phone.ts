import { useEffect, useState } from "react";

/*
 * What counts as a phone for the editor's touch surfaces: a primary coarse
 * pointer on a narrow screen. The comment sheet, the selection action bar and
 * the margin markers all ask this one question, so a shared phone class can
 * replace it here.
 */
export const PHONE_MAX_WIDTH = 430;
export const PHONE_QUERY = `(pointer: coarse) and (max-width: ${PHONE_MAX_WIDTH}px)`;

export function isPhone({ coarse, width }: { coarse: boolean; width: number }): boolean {
	return coarse && width <= PHONE_MAX_WIDTH;
}

export function usePhone(): boolean {
	let [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
	useEffect(() => {
		let query = matchMedia(PHONE_QUERY);
		let update = () => setPhone(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return phone;
}
