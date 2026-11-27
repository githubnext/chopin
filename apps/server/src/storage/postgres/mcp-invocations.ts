import type { SQL, TransactionSQL } from "bun";
import type { Lease, McpInvocation, McpInvocationResult, McpInvocationScope } from "../model";
import type { McpInvocationStore } from "../port";

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;
type Fence = (transaction: TransactionSQL, lease: Lease) => Promise<void>;

type InvocationRow = {
	userId: string;
	channelId: string;
	key: string;
	fingerprint: string;
	entryId: string;
	result: McpInvocationResult | string;
	createdAt: Date | string;
	expiresAt: Date | string;
	invokedAt: Date | string | null;
	uncertainAt: Date | string | null;
};

function invocation(row: InvocationRow): McpInvocation {
	return {
		userId: row.userId,
		channelId: row.channelId,
		key: row.key,
		fingerprint: row.fingerprint,
		entryId: row.entryId,
		result: typeof row.result === "string" ? JSON.parse(row.result) : row.result,
		createdAt: new Date(row.createdAt),
		expiresAt: new Date(row.expiresAt),
		...(row.invokedAt ? { invokedAt: new Date(row.invokedAt) } : {}),
		...(row.uncertainAt ? { uncertainAt: new Date(row.uncertainAt) } : {}),
	};
}

export class PostgresMcpInvocationStore implements McpInvocationStore {
	constructor(private sql: SQL, private run: Run, private fence: Fence) {}
	claim(lease: Lease, value: Omit<McpInvocation, "invokedAt" | "uncertainAt">) {
		return this.run(
			"claim an invoke_planner idempotency key",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					await transaction`
					DELETE FROM mcp_invocations
					WHERE user_id = ${value.userId} AND channel_id = ${value.channelId}
						AND key = ${value.key} AND expires_at <= ${value.createdAt}
				`;
					let [inserted] = await transaction<InvocationRow[]>`
					INSERT INTO mcp_invocations (
						user_id, channel_id, key, fingerprint, entry_id, result, created_at, expires_at
					) VALUES (
						${value.userId}, ${value.channelId}, ${value.key}, ${value.fingerprint},
						${value.entryId}, ${JSON.stringify(value.result)}::text::jsonb, ${value.createdAt},
						${value.expiresAt}
					)
					ON CONFLICT (user_id, channel_id, key) DO NOTHING
					RETURNING user_id AS "userId", channel_id AS "channelId", key, fingerprint,
						entry_id AS "entryId", result, created_at AS "createdAt", expires_at AS "expiresAt",
						invoked_at AS "invokedAt", uncertain_at AS "uncertainAt"
				`;
					if (inserted) return { record: invocation(inserted), claimed: true };
					let [held] = await transaction<InvocationRow[]>`
					SELECT user_id AS "userId", channel_id AS "channelId", key, fingerprint,
						entry_id AS "entryId", result, created_at AS "createdAt", expires_at AS "expiresAt",
						invoked_at AS "invokedAt", uncertain_at AS "uncertainAt"
					FROM mcp_invocations
					WHERE user_id = ${value.userId} AND channel_id = ${value.channelId}
						AND key = ${value.key}
				`;
					if (!held) throw new Error("an idempotency key's record vanished while it was claimed");
					return { record: invocation(held), claimed: false };
				}),
		);
	}
	complete(
		lease: Lease,
		scope: McpInvocationScope & { entryId: string },
		at: Date,
		result?: McpInvocationResult,
	) {
		return this.run(
			"mark an invoke_planner call invoked",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let completed = result === undefined
						? await transaction<{ key: string }[]>`
							UPDATE mcp_invocations SET invoked_at = ${at}
							WHERE user_id = ${scope.userId} AND channel_id = ${scope.channelId}
								AND key = ${scope.key} AND entry_id = ${scope.entryId} AND invoked_at IS NULL
								AND uncertain_at IS NULL
							RETURNING key
						`
						: await transaction<{ key: string }[]>`
							UPDATE mcp_invocations
							SET invoked_at = ${at}, result = ${JSON.stringify(result)}::text::jsonb
							WHERE user_id = ${scope.userId} AND channel_id = ${scope.channelId}
								AND key = ${scope.key} AND entry_id = ${scope.entryId} AND invoked_at IS NULL
								AND uncertain_at IS NULL
							RETURNING key
						`;
					return completed.length > 0;
				}),
		);
	}
	uncertain(lease: Lease, scope: McpInvocationScope & { entryId: string }, at: Date) {
		return this.run(
			"mark an invoke_planner call uncertain",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let marked = await transaction<{ key: string }[]>`
					UPDATE mcp_invocations SET uncertain_at = ${at}
					WHERE user_id = ${scope.userId} AND channel_id = ${scope.channelId}
						AND key = ${scope.key} AND entry_id = ${scope.entryId} AND invoked_at IS NULL
						AND uncertain_at IS NULL
					RETURNING key
				`;
					return marked.length > 0;
				}),
		);
	}
	release(lease: Lease, scope: McpInvocationScope & { entryId: string }) {
		return this.run(
			"release an invoke_planner idempotency key",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let released = await transaction<{ key: string }[]>`
					DELETE FROM mcp_invocations
					WHERE user_id = ${scope.userId} AND channel_id = ${scope.channelId}
						AND key = ${scope.key} AND entry_id = ${scope.entryId} AND invoked_at IS NULL
						AND uncertain_at IS NULL
					RETURNING key
				`;
					return released.length > 0;
				}),
		);
	}
	get(scope: McpInvocationScope) {
		return this.run("read an invoke_planner idempotency key", async () => {
			let [row] = await this.sql<InvocationRow[]>`
				SELECT user_id AS "userId", channel_id AS "channelId", key, fingerprint,
					entry_id AS "entryId", result, created_at AS "createdAt", expires_at AS "expiresAt",
					invoked_at AS "invokedAt", uncertain_at AS "uncertainAt"
				FROM mcp_invocations
				WHERE user_id = ${scope.userId} AND channel_id = ${scope.channelId}
					AND key = ${scope.key}
			`;
			return row && invocation(row);
		});
	}
	deleteExpired(now: Date) {
		return this.run("sweep expired invoke_planner idempotency keys", async () => {
			let removed = await this.sql<{ key: string }[]>`
				DELETE FROM mcp_invocations WHERE expires_at <= ${now} RETURNING key
			`;
			return removed.length;
		});
	}
}
