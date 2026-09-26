/** File-backed Bun.secrets test double loaded only by the disposable local E2E server. */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

let directory = process.env.E2E_FAKE_VAULT_DIR;
if (process.env.AUTH_MODE === "local" && directory) {
	let file = (service: string, name: string) =>
		join(directory, createHash("sha256").update(JSON.stringify([service, name])).digest("hex"));
	let fake: Pick<typeof Bun.secrets, "get" | "set" | "delete"> = {
		get: async ({ service, name }) => {
			if (process.env.E2E_FAKE_VAULT_UNAVAILABLE === "1") throw new Error("vault unavailable");
			return await readFile(file(service, name), "utf8").catch(() => null);
		},
		set: async ({ service, name, value }) => {
			if (process.env.E2E_FAKE_VAULT_UNAVAILABLE === "1") throw new Error("vault unavailable");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(file(service, name), value, { mode: 0o600 });
		},
		delete: async ({ service, name }) => {
			await rm(file(service, name), { force: true });
			return true;
		},
	};
	(Bun as unknown as { secrets: typeof fake }).secrets = fake;
}
