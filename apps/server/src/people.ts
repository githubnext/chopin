/**
 * The people a document names, and the pictures GitHub gave their logins.
 *
 * A face is drawn for every login the server sends, and `github.com/<login>.png` is only a guess
 * at its picture: it does not exist for every account (an Enterprise Managed User's
 * `name_company` has none). The picture GitHub's API returned when the person signed in is stored
 * with their user and is always right, so the server tells each socket, along with the logins, the
 * pictures that belong to them: present members carry theirs (`Session.Member`), and this module
 * covers everyone else the document's own content names. Only sockets joined to the room hear it,
 * which are the ones allowed to read the document.
 */

import { broadcast, tell } from "./wire";

import type { Server } from "bun";
import type { Session } from "@chopin/protocol";
import type { Chat } from "./chat/service";
import type { Record as Thread } from "./comments/service";
import type { Record as Decision } from "./questions/record-types";
import type { UserStore } from "./storage/port";
import type { Socket, SocketData } from "./wire";

/** What of a document names a person; a `Plan` is one. */
export type Named = {
	chat: Pick<Chat, "entries" | "waiting" | "turn">;
	threads: ReadonlyMap<string, Pick<Thread, "notes" | "resolver">>;
	records: ReadonlyMap<
		string,
		Pick<
			Decision,
			"owner" | "resolver" | "editors" | "history" | "optionOrigins" | "findings" | "whyBy"
		>
	>;
	/** Builds name the person who started them, and whose machine ran them, by user ID. */
	builds: readonly { user: string; machineOwner?: string }[];
	live?: { user: string };
};

/**
 * The user IDs of everyone who started a build of the document, ran one on their machine, or built
 * it live. Build cards draw them by login, which the server resolves from the ID, so no login is
 * stored in the document for `named` to find.
 */
export function builders(plan: Pick<Named, "builds" | "live">): string[] {
	let ids = new Set<string>();
	for (let build of plan.builds) {
		ids.add(build.user);
		if (build.machineOwner) ids.add(build.machineOwner);
	}
	if (plan.live) ids.add(plan.live.user);
	return [...ids];
}

/**
 * Every login the document's stored content credits: who spoke in Chat (and is waiting to),
 * who wrote or resolved a comment, and who owned, settled, edited, explained or was asked about a
 * decision. Each once, in the spelling first met. A demo actor is a roster ID, not a login.
 */
export function named(plan: Named): string[] {
	let seen = new Map<string, string>();
	let add = (login: string | undefined) => {
		if (!login || login.startsWith("demo:")) return;
		let key = login.toLowerCase();
		if (!seen.has(key)) seen.set(key, login);
	};
	for (let entry of plan.chat.entries) {
		if (entry.author.kind === "member") add(entry.author.handle);
	}
	for (let waiting of plan.chat.waiting) add(waiting.handle);
	add(plan.chat.turn?.handle);
	for (let thread of plan.threads.values()) {
		for (let note of thread.notes) if (note.author === "member") add(note.handle);
		add(thread.resolver);
	}
	for (let decision of plan.records.values()) {
		add(decision.owner);
		add(decision.resolver);
		for (let editor of decision.editors) add(editor);
		for (let entry of decision.history) add(entry.owner);
		for (let origin of Object.values(decision.optionOrigins)) add(origin.by);
		for (let finding of decision.findings ?? []) {
			// An ask's reference is the member who was asked; any other kind's is a request ID.
			if (finding.kind === "ask") add(finding.ref);
			add(finding.by);
		}
		add(decision.whyBy);
	}
	return [...seen.values()];
}

/** The stored picture of each person, named by login or by user ID, that has one. */
export async function pictures(
	users: Pick<UserStore, "byLogins" | "get">,
	who: { logins: readonly string[]; ids?: readonly string[] },
): Promise<Session.Person[]> {
	let found = new Map<string, Session.Person>();
	let keep = (user: { login: string; avatarUrl: string } | undefined) => {
		if (user?.avatarUrl) {
			found.set(user.login.toLowerCase(), { login: user.login, avatarUrl: user.avatarUrl });
		}
	};
	if (who.logins.length) { for (let user of await users.byLogins(who.logins)) keep(user); }
	for (let id of who.ids ?? []) keep(await users.get(id));
	return [...found.values()];
}

/** Tell one socket who these people are, before the frames that name them. */
export function present(ws: Socket, people: readonly Session.Person[]): void {
	if (people.length) tell(ws, { kind: "session:people", ts: 0, people: [...people] });
}

/**
 * Tell the whole room who someone is, as something they said is posted: a person who has no
 * socket in the room, such as a coding agent's caller posting through MCP, has not been met by it.
 */
export function introduce(
	server: Server<SocketData>,
	room: string,
	person: { login: string; avatarUrl?: string },
): void {
	if (!person.avatarUrl) return;
	broadcast(server, room, {
		kind: "session:people",
		ts: 0,
		people: [{ login: person.login, avatarUrl: person.avatarUrl }],
	});
}
