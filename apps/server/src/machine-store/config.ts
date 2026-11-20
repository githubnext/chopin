import { readFileSync } from "node:fs";

export type MachineStoreConfig = {
	url: string;
	password?: string;
	retentionMs?: number;
};

const DAY_MS = 86_400_000;

export function machineStoreConfig(
	env: Record<string, string | undefined>,
): MachineStoreConfig | undefined {
	let raw = env.MACHINE_STORE_URL?.trim();
	let inline = env.MACHINE_STORE_PASSWORD;
	let file = env.MACHINE_STORE_PASSWORD_FILE?.trim();
	let retention = env.MACHINE_STORE_RETENTION_DAYS?.trim();
	if (!raw) {
		if (inline || file || retention) {
			throw new Error(
				"MACHINE_STORE_PASSWORD, MACHINE_STORE_PASSWORD_FILE and MACHINE_STORE_RETENTION_DAYS "
					+ "need MACHINE_STORE_URL",
			);
		}
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(raw);
		if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
	} catch {
		throw new Error("MACHINE_STORE_URL must be a PostgreSQL URL");
	}
	if (!url.hostname || !url.username) {
		throw new Error("MACHINE_STORE_URL must name the server's host and its administrator role");
	}
	if (url.password || url.searchParams.has("password")) {
		throw new Error(
			"MACHINE_STORE_URL must not hold a password: set MACHINE_STORE_PASSWORD_FILE or "
				+ "MACHINE_STORE_PASSWORD",
		);
	}
	if (inline && file) {
		throw new Error("Set MACHINE_STORE_PASSWORD or MACHINE_STORE_PASSWORD_FILE, not both");
	}
	let password = inline;
	if (file) {
		try {
			password = readFileSync(file, "utf8").replace(/\r?\n$/, "");
		} catch {
			throw new Error("MACHINE_STORE_PASSWORD_FILE can't be read");
		}
	}
	let retentionMs: number | undefined;
	if (retention) {
		let days = Number(retention);
		if (!/^\d+$/.test(retention) || !Number.isSafeInteger(days) || days > 36_500) {
			throw new Error("MACHINE_STORE_RETENTION_DAYS must be a whole number of days up to 36500");
		}
		retentionMs = days * DAY_MS;
	}
	return {
		url: url.href,
		...(password ? { password } : {}),
		...(retentionMs === undefined ? {} : { retentionMs }),
	};
}
