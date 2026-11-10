/** Cancelling and editing a waiting message, with every durable piece real on memory storage. */
import { afterEach } from "bun:test";

import { cleanups, world } from "./deferred.test-fixtures";
import { queueActions } from "./queue-actions.test-fixtures";
import * as Chat from "./service";

afterEach(async () => {
	Chat.holdStarts(false);
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

queueActions(extra => world(extra), { interleavings: 12 });
