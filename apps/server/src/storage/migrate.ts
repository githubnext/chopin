import { load } from "../config";
import { createStorage } from "./registry";

let config = load();
let storage = createStorage(config.storage);

if (!storage) {
	console.error("chopin: STORAGE_DRIVER=legacy has no database migrations");
	process.exit(1);
}

try {
	await storage.migrate();
	console.log(`chopin: ${storage.driver} storage is up to date`);
} catch (err) {
	let reason = err instanceof Error ? err.message : String(err);
	console.error(`chopin: storage migration failed - ${reason}`);
	process.exitCode = 1;
} finally {
	await storage.close().catch(() => {});
}
