export const MACHINE_STORE_ADAPTER = "@bastani/atomic-storage-postgres";

export type MachineStoreLogin = { url: string; password: string };

export type MachineStoreStatus =
	| { state: "ready" }
	| { state: "pending" }
	| { state: "failed"; reason: string };

export const MACHINE_STORE_REASON_LIMIT = 300;

export function passwordlessStoreUrl(value: unknown): value is string {
	if (typeof value !== "string" || !URL.canParse(value)) return false;
	let url = new URL(value);
	return (url.protocol === "postgresql:" || url.protocol === "postgres:") && !url.password
		&& !!url.username && url.pathname.length > 1 && !url.searchParams.has("password");
}
