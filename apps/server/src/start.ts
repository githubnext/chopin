import { load } from "./config";
import { createStorage } from "./storage/registry";

let config = load();
let storage = createStorage(config.storage);
let owner = crypto.randomUUID();

try {
	await storage.migrate(owner);
} finally {
	await storage.close();
}

process.env.CHOPIN_WRITER_OWNER = owner;
await import("./main");
