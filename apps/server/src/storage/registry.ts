import { PostgresStorage } from "./postgres/adapter";

import type { StorageAdapter } from "./port";

export type StorageConfig = { driver: "postgres"; url: string };

/** Built-in adapters are selected here; domain services never import one. */
export function createStorage(config: StorageConfig): StorageAdapter {
	switch (config.driver) {
		case "postgres":
			return new PostgresStorage(config.url);
	}
}
