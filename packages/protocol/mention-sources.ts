/**
 * What `#` and Mention docs can point at in a document, as the server lists it for a typed query:
 * the same lists it resolves a message's references against, so nothing offered is refused for
 * being a different part. `GET /api/channels/:id/mentions?query=`.
 */

export type MentionSources = {
	/** The document's top-level headings, each told by its anchor. */
	headings: Array<{ anchor: string; text: string; level: number }>;
	/** Its Decisions, each told by its id. */
	decisions: Array<{ id: string; title: string }>;
	/** Its research cards, each told by its workspace. */
	research: Array<{ workspaceId: string; title: string }>;
	/** The repository's files, by path; absent when none can be listed for this document. */
	files?: string[];
};

/** One person who can read a document, with the avatar GitHub gave their login. */
export type DocumentPerson = {
	login: string;
	avatarUrl: string;
};

/**
 * The people `@` can mention in a document (`GET /api/channels/:id/people`). `authoritative` is
 * true when GitHub listed the repository's collaborators directly, and false when only the
 * document's known authors could be read.
 */
export type DocumentPeople = {
	people: DocumentPerson[];
	authoritative: boolean;
};

/** The most of each kind one answer holds, and what it holds when none is asked for. */
export const MAX_MENTION_SOURCES = 20;
export const DEFAULT_MENTION_SOURCES = 6;
/** A longer query cannot name anything here. */
export const MAX_MENTION_SOURCE_QUERY = 64;
