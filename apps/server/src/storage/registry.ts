import { PostgresStorage } from "./postgres/adapter";

import type { StorageAdapter } from "./port";

export type StorageConfig =
	| { driver: "legacy" }
	| { driver: "postgres"; url: string };

/** Built-in adapters are selected here; domain services never import one. */
export function createStorage(config: StorageConfig): StorageAdapter | undefined {
	switch (config.driver) {
		case "legacy":
			return undefined;
		case "postgres":
			return new PostgresStorage(config.url);
	}
}
