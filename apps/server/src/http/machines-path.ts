import type { Router } from "./router";

/** The Machines page: the person's machines, adding one, and approving a pairing. */
export const MACHINES_PATH = "/machines";

/**
 * Its former address, `/connect`, redirects there with its query, so a pairing link a connector
 * printed before (`/connect?pairing=…`) still opens the pairing approval.
 */
export function registerMachinesPath(router: Router): void {
	let redirect = (_request: Request, url: URL) =>
		new Response(null, {
			status: 308,
			headers: { location: `${MACHINES_PATH}${url.search}`, "cache-control": "no-cache" },
		});
	for (let path of ["/connect", "/connect/"]) {
		router.on("GET", path, redirect);
		router.on("HEAD", path, redirect);
	}
}
