import { useEffect, useState } from "react";

import { rememberAvatars } from "@chopin/editor/people";

import { response } from "../api";

import type { DocumentPeople } from "@chopin/protocol/mention-sources";

/**
 * The logins of the people who can read the document, asked of the server once per document the
 * first time `@` is typed, with each person's GitHub picture remembered for the faces that draw
 * them. None until the answer is here, and none after a failure: the people here, the people who
 * have spoken in Chat and Chopin are still offered without it.
 */
export function useDocumentPeople(room: string, wanted: boolean): readonly string[] {
	let [held, setHeld] = useState<{ room: string; logins: string[] }>();
	let asked = wanted || held?.room === room;
	useEffect(() => {
		if (!asked || held?.room === room) return;
		let controller = new AbortController();
		response<DocumentPeople>(`/api/channels/${encodeURIComponent(room)}/people`, {
			signal: controller.signal,
		}).then(answer => {
			rememberAvatars(answer.people.filter(person => person.avatarUrl));
			setHeld({ room, logins: answer.people.map(person => person.login) });
		}, () => {
			if (!controller.signal.aborted) setHeld({ room, logins: [] });
		});
		return () => controller.abort();
	}, [room, asked, held?.room]);
	return held?.room === room ? held.logins : [];
}
