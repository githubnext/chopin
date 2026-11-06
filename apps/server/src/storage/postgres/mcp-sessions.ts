import type { SQL } from "bun";
import type { McpSession } from "../model";
import type { McpSessionStore } from "../port";

type SessionRow = {
	id: string;
	userId: string;
	clientName: string;
	clientVersion: string;
	createdAt: Date | string;
	lastSeenAt: Date | string;
};

export class PostgresMcpSessionStore implements McpSessionStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	create(session: McpSession) {
		return this.run("save an MCP session", async () => {
			await this.sql`
				INSERT INTO mcp_sessions (
					id, user_id, client_name, client_version, created_at, last_seen_at
				) VALUES (
					${session.id}, ${session.userId}, ${session.clientName}, ${session.clientVersion},
					${session.createdAt}, ${session.lastSeenAt}
				)
				ON CONFLICT (id) DO NOTHING
			`;
		});
	}
	find(id: string) {
		return this.run("read an MCP session", async () => {
			let [row] = await this.sql<SessionRow[]>`
				SELECT id, user_id AS "userId", client_name AS "clientName",
					client_version AS "clientVersion", created_at AS "createdAt",
					last_seen_at AS "lastSeenAt"
				FROM mcp_sessions WHERE id = ${id}
			`;
			return row && {
				id: row.id,
				userId: row.userId,
				clientName: row.clientName,
				clientVersion: row.clientVersion,
				createdAt: new Date(row.createdAt),
				lastSeenAt: new Date(row.lastSeenAt),
			};
		});
	}
	touch(id: string, now: Date) {
		return this.run("record MCP session activity", async () => {
			let touched = await this.sql<{ id: string }[]>`
				UPDATE mcp_sessions SET last_seen_at = GREATEST(last_seen_at, ${now})
				WHERE id = ${id}
				RETURNING id
			`;
			return touched.length > 0;
		});
	}
	deleteIdle(before: Date) {
		return this.run("sweep idle MCP sessions", async () => {
			let removed = await this.sql<{ id: string }[]>`
				DELETE FROM mcp_sessions WHERE last_seen_at < ${before} RETURNING id
			`;
			return removed.length;
		});
	}
}
