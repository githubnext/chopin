import type { SQL, TransactionSQL } from "bun";
import type { ChatSessionState, ChatThreadRecord, Lease } from "../model";
import type { ChatThreadStore } from "../port";

type ThreadRow = {
	channelId: string;
	rootId: string;
	rootJson: ChatThreadRecord["root"] | string;
	forkedAt: number | string;
	createdBy: string;
	entriesJson: ChatThreadRecord["entries"] | string;
	lastSeq: number | string | null;
	compactionsJson: ChatThreadRecord["compactions"] | string;
	usageJson: ChatThreadRecord["usage"] | string | null;
	forkStateJson: ChatThreadRecord["forkState"] | string;
	askedQuestionsJson: NonNullable<ChatThreadRecord["askedQuestions"]> | string;
	updatedAt: Date | string;
};

type SessionRow = {
	channelId: string;
	compactionsJson: ChatSessionState["compactions"] | string;
	usageJson: ChatSessionState["usage"] | string | null;
	atomicEntriesJson: ChatSessionState["atomicEntries"] | string | null;
	atomicLeafId: string | null;
	entryForksJson: ChatSessionState["entryForks"] | string;
	threadNotesJson: NonNullable<ChatSessionState["threadNotes"]> | string;
	notedQuestionsJson: NonNullable<ChatSessionState["notedQuestions"]> | string;
	givenNotesJson: ChatSessionState["givenNotes"] | string | null;
	updatedAt: Date | string;
};

function parseJson<T>(value: T | string): T {
	return typeof value === "string" ? JSON.parse(value) as T : structuredClone(value);
}

function hydrateThread(row: ThreadRow): ChatThreadRecord {
	let usage = row.usageJson === null ? undefined : parseJson(row.usageJson);
	let askedQuestions = parseJson(row.askedQuestionsJson);
	return {
		channelId: row.channelId,
		rootId: row.rootId,
		root: parseJson(row.rootJson),
		forkedAt: Number(row.forkedAt),
		createdBy: row.createdBy,
		entries: parseJson(row.entriesJson),
		...(row.lastSeq === null ? {} : { lastSeq: Number(row.lastSeq) }),
		compactions: parseJson(row.compactionsJson),
		...(usage ? { usage } : {}),
		forkState: parseJson(row.forkStateJson),
		...(askedQuestions.length ? { askedQuestions } : {}),
		updatedAt: new Date(row.updatedAt),
	};
}

function hydrateSession(row: SessionRow): ChatSessionState {
	let usage = row.usageJson === null ? undefined : parseJson(row.usageJson);
	let atomicEntries = row.atomicEntriesJson === null ? undefined : parseJson(row.atomicEntriesJson);
	let threadNotes = parseJson(row.threadNotesJson);
	let notedQuestions = parseJson(row.notedQuestionsJson);
	let givenNotes = row.givenNotesJson === null ? undefined : parseJson(row.givenNotesJson);
	return {
		channelId: row.channelId,
		compactions: parseJson(row.compactionsJson),
		...(usage ? { usage } : {}),
		...(atomicEntries !== undefined ? { atomicEntries } : {}),
		...(atomicEntries !== undefined ? { atomicLeafId: row.atomicLeafId } : {}),
		entryForks: parseJson(row.entryForksJson),
		...(threadNotes.length ? { threadNotes } : {}),
		...(notedQuestions.length ? { notedQuestions } : {}),
		...(givenNotes ? { givenNotes } : {}),
		updatedAt: new Date(row.updatedAt),
	};
}

export class PostgresChatThreadStore implements ChatThreadStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}

	putThread(lease: Lease, thread: ChatThreadRecord): Promise<void> {
		return this.run("save a Chat thread", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				let rootJson = JSON.stringify(thread.root);
				let entriesJson = JSON.stringify(thread.entries);
				let compactionsJson = JSON.stringify(thread.compactions);
				let usageJson = thread.usage === undefined ? null : JSON.stringify(thread.usage);
				let forkStateJson = JSON.stringify(thread.forkState);
				let askedQuestionsJson = JSON.stringify(thread.askedQuestions ?? []);
				await sql`
					INSERT INTO chat_threads (
						channel_id, root_id, root_json, forked_at, created_by,
						entries_json, last_seq, compactions_json, usage_json, fork_state_json,
						asked_questions_json, updated_at, fencing
					) VALUES (
						${thread.channelId}, ${thread.rootId}, ${rootJson}::text::jsonb,
						${thread.forkedAt}, ${thread.createdBy},
						${entriesJson}::text::jsonb, ${thread.lastSeq ?? null},
						${compactionsJson}::text::jsonb,
						${usageJson}::text::jsonb, ${forkStateJson}::text::jsonb,
						${askedQuestionsJson}::text::jsonb, ${thread.updatedAt}, ${lease.fencing}
					)
					ON CONFLICT (channel_id, root_id) DO UPDATE SET
						root_json = EXCLUDED.root_json,
						forked_at = EXCLUDED.forked_at,
						created_by = EXCLUDED.created_by,
						entries_json = EXCLUDED.entries_json,
						last_seq = EXCLUDED.last_seq,
						compactions_json = EXCLUDED.compactions_json,
						usage_json = EXCLUDED.usage_json,
						fork_state_json = EXCLUDED.fork_state_json,
						asked_questions_json = EXCLUDED.asked_questions_json,
						updated_at = EXCLUDED.updated_at,
						fencing = EXCLUDED.fencing
				`;
			}));
	}

	getThread(channelId: string, rootId: string): Promise<ChatThreadRecord | undefined> {
		return this.run("read a Chat thread", async () => {
			let [row] = await this.sql<ThreadRow[]>`
				SELECT channel_id AS "channelId", root_id AS "rootId", root_json AS "rootJson",
					forked_at AS "forkedAt", created_by AS "createdBy",
					entries_json AS "entriesJson", last_seq AS "lastSeq", compactions_json AS "compactionsJson",
					usage_json AS "usageJson", fork_state_json AS "forkStateJson",
					asked_questions_json AS "askedQuestionsJson", updated_at AS "updatedAt"
				FROM chat_threads
				WHERE channel_id = ${channelId} AND root_id = ${rootId}
			`;
			return row && hydrateThread(row);
		});
	}

	listThreads(channelId: string): Promise<ChatThreadRecord[]> {
		return this.run("list Chat threads", async () => {
			let rows = await this.sql<ThreadRow[]>`
				SELECT channel_id AS "channelId", root_id AS "rootId", root_json AS "rootJson",
					forked_at AS "forkedAt", created_by AS "createdBy",
					entries_json AS "entriesJson", last_seq AS "lastSeq", compactions_json AS "compactionsJson",
					usage_json AS "usageJson", fork_state_json AS "forkStateJson",
					asked_questions_json AS "askedQuestionsJson", updated_at AS "updatedAt"
				FROM chat_threads
				WHERE channel_id = ${channelId}
				ORDER BY forked_at ASC, root_id ASC
			`;
			return rows.map(hydrateThread);
		});
	}

	putSessionState(lease: Lease, state: ChatSessionState): Promise<void> {
		return this.run("save Chat session state", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				let compactionsJson = JSON.stringify(state.compactions);
				let usageJson = state.usage === undefined ? null : JSON.stringify(state.usage);
				let atomicEntriesJson = state.atomicEntries === undefined
					? null
					: JSON.stringify(state.atomicEntries);
				let atomicLeafId = state.atomicEntries === undefined
					? null
					: (state.atomicLeafId ?? null);
				let entryForksJson = JSON.stringify(state.entryForks);
				let threadNotesJson = JSON.stringify(state.threadNotes ?? []);
				let notedQuestionsJson = JSON.stringify(state.notedQuestions ?? []);
				let givenNotesJson = state.givenNotes ? JSON.stringify(state.givenNotes) : null;
				await sql`
					INSERT INTO chat_session_state (
						channel_id, compactions_json, usage_json, atomic_entries_json,
						atomic_leaf_id, entry_forks_json, thread_notes_json, noted_questions_json,
						given_notes_json, updated_at, fencing
					) VALUES (
						${state.channelId}, ${compactionsJson}::text::jsonb, ${usageJson}::text::jsonb,
						${atomicEntriesJson}::text::jsonb, ${atomicLeafId}, ${entryForksJson}::text::jsonb,
						${threadNotesJson}::text::jsonb, ${notedQuestionsJson}::text::jsonb,
						${givenNotesJson}::text::jsonb, ${state.updatedAt}, ${lease.fencing}
					)
					ON CONFLICT (channel_id) DO UPDATE SET
						compactions_json = EXCLUDED.compactions_json,
						usage_json = EXCLUDED.usage_json,
						atomic_entries_json = EXCLUDED.atomic_entries_json,
						atomic_leaf_id = EXCLUDED.atomic_leaf_id,
						entry_forks_json = EXCLUDED.entry_forks_json,
						thread_notes_json = EXCLUDED.thread_notes_json,
						noted_questions_json = EXCLUDED.noted_questions_json,
						given_notes_json = EXCLUDED.given_notes_json,
						updated_at = EXCLUDED.updated_at,
						fencing = EXCLUDED.fencing
				`;
			}));
	}

	getSessionState(channelId: string): Promise<ChatSessionState | undefined> {
		return this.run("read Chat session state", async () => {
			let [row] = await this.sql<SessionRow[]>`
				SELECT channel_id AS "channelId", compactions_json AS "compactionsJson",
					usage_json AS "usageJson", atomic_entries_json AS "atomicEntriesJson",
					atomic_leaf_id AS "atomicLeafId", entry_forks_json AS "entryForksJson",
					thread_notes_json AS "threadNotesJson",
					noted_questions_json AS "notedQuestionsJson",
					given_notes_json AS "givenNotesJson", updated_at AS "updatedAt"
				FROM chat_session_state
				WHERE channel_id = ${channelId}
			`;
			return row && hydrateSession(row);
		});
	}
}
