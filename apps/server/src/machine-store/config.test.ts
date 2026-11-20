import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineStoreConfig } from "./config";

let folder = mkdtempSync(join(tmpdir(), "machine-store-config-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

describe("MACHINE_STORE_URL", () => {
	test("leaves the feature off without it", () => {
		expect(machineStoreConfig({})).toBeUndefined();
		expect(() => machineStoreConfig({ MACHINE_STORE_PASSWORD: "x" })).toThrow(
			"need MACHINE_STORE_URL",
		);
	});

	test("reads the administrator's password from a file or a variable, never the URL", () => {
		let file = join(folder, "password");
		writeFileSync(file, "from-a-file\n", { mode: 0o600 });
		expect(
			machineStoreConfig({
				MACHINE_STORE_URL: "postgresql://admin@db.example.com:5432/postgres?sslmode=verify-full",
				MACHINE_STORE_PASSWORD_FILE: file,
			}),
		).toEqual({
			url: "postgresql://admin@db.example.com:5432/postgres?sslmode=verify-full",
			password: "from-a-file",
		});
		expect(
			machineStoreConfig({
				MACHINE_STORE_URL: "postgres://admin@db.example.com/postgres",
				MACHINE_STORE_PASSWORD: "from-a-secret",
				MACHINE_STORE_RETENTION_DAYS: "30",
			}),
		).toEqual({
			url: "postgres://admin@db.example.com/postgres",
			password: "from-a-secret",
			retentionMs: 30 * 86_400_000,
		});
		for (
			let url of [
				"postgresql://admin:hunter2-secret@db.example.com/postgres",
				"postgresql://admin@db.example.com/postgres?password=hunter2-secret",
			]
		) {
			let error = (() => {
				try {
					machineStoreConfig({ MACHINE_STORE_URL: url });
				} catch (error) {
					return error as Error;
				}
			})();
			expect(error?.message).toContain("must not hold a password");
			expect(error?.message).not.toContain("hunter2");
		}
	});

	test("refuses settings that can't work, without echoing a secret", () => {
		let base = { MACHINE_STORE_URL: "postgresql://admin@db.example.com/postgres" };
		expect(() => machineStoreConfig({ MACHINE_STORE_URL: "https://db.example.com" })).toThrow(
			"must be a PostgreSQL URL",
		);
		expect(() => machineStoreConfig({ MACHINE_STORE_URL: "postgresql://db.example.com/postgres" }))
			.toThrow("administrator role");
		expect(() =>
			machineStoreConfig({
				...base,
				MACHINE_STORE_PASSWORD: "a",
				MACHINE_STORE_PASSWORD_FILE: join(folder, "password"),
			})
		).toThrow("not both");
		expect(() =>
			machineStoreConfig({ ...base, MACHINE_STORE_PASSWORD_FILE: join(folder, "missing") })
		).toThrow("MACHINE_STORE_PASSWORD_FILE can't be read");
		expect(() => machineStoreConfig({ ...base, MACHINE_STORE_RETENTION_DAYS: "-1" })).toThrow(
			"MACHINE_STORE_RETENTION_DAYS",
		);
	});
});
