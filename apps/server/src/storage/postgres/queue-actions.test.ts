import { afterEach, describe } from "bun:test";

import { cleanups, world } from "../../chat/deferred.test-fixtures";
import { queueActions } from "../../chat/queue-actions.test-fixtures";
import * as Chat from "../../chat/service";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

afterEach(async () => {
	Chat.holdStarts(false);
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Cancelling and editing a waiting message against PostgreSQL: the row's lock decides a race with
 * the start of its turn, and each "process" has its own connections and writer lease.
 */
describe.skipIf(!url)("PostgreSQL queue actions", () => {
	queueActions(async extra => {
		let opened: PostgresStorage[] = [];
		let connect = async () => {
			let storage = new PostgresStorage(url!);
			await storage.migrate();
			opened.push(storage);
			return storage;
		};
		let lease = `chopin:test-queue-${crypto.randomUUID()}`;
		cleanups.push(async () => {
			for (let storage of opened) await storage.close().catch(() => {});
		});
		return world({ ...extra, storage: await connect(), reopen: connect, lease });
	}, { interleavings: 5 });
});
