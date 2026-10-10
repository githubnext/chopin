import { useEffect, useState } from "react";

import type { Session } from "./api";

// Read from the room chunk with a direct request: importing the session reader here would
// add a re-export to the initial chunk, which sits at its bundle budget.
let enabled: Promise<boolean> | undefined;

/** Whether this server offers the living-document build. */
export function useLiveBuild(): boolean {
	let [value, setValue] = useState(false);
	useEffect(() => {
		let active = true;
		enabled ??= fetch("/api/session", { credentials: "same-origin" })
			.then(response => response.ok ? response.json() as Promise<Session> : undefined)
			.then(session => !!session?.liveBuild, () => false);
		void enabled.then(result => {
			if (active) setValue(result);
		});
		return () => {
			active = false;
		};
	}, []);
	return value;
}
