import { useEffect, useRef, useState } from "react";

import { response } from "../api";

import type { MentionSources } from "@chopin/protocol/mention-sources";
import type { PointerTarget } from "./references";

/** One thing `@` can point at in the document or its repository, with the words its chip shows. */
export type PointerOption = PointerTarget & {
	/** Unique in the list. */
	id: string;
	/** Right-aligned detail, such as a heading's level. */
	meta?: string;
};

export type PointerGroup = { label: string; options: PointerOption[] };

/** What the server listed, as the groups the menu shows, in the order a person looks for them. */
export function pointerGroups(sources: MentionSources | undefined): PointerGroup[] {
	if (!sources) return [];
	let groups: PointerGroup[] = [
		{
			label: "Sections",
			options: sources.headings.map(heading => ({
				id: `heading:${heading.anchor}`,
				kind: "heading" as const,
				anchor: heading.anchor,
				label: heading.text,
				meta: `H${heading.level}`,
			})),
		},
		{
			label: "Decisions",
			options: sources.decisions.map(decision => ({
				id: `decision:${decision.id}`,
				kind: "decision" as const,
				decisionId: decision.id,
				label: decision.title || "Decision",
			})),
		},
		{
			label: "Research",
			options: sources.research.map(card => ({
				id: `research:${card.workspaceId}`,
				kind: "research" as const,
				workspaceId: card.workspaceId,
				label: card.title,
			})),
		},
		{
			label: "Files",
			options: (sources.files ?? []).map(path => ({
				id: `file:${path}`,
				kind: "file" as const,
				path,
				label: path,
			})),
		},
	];
	return groups.filter(group => group.options.length > 0);
}

const DELAY = 150;

/**
 * What `@` can point at for the typed query, asked of the server as the person types, with each
 * answer replacing the one before it and never one for an older query. None while there is no
 * query to ask about, until the answer to this query is here, and after a failure: people and
 * Chopin are still offered without it.
 */
export function useMentionSources(
	room: string,
	query: string | undefined,
): MentionSources | undefined {
	let [held, setHeld] = useState<{ room: string; query: string; sources: MentionSources }>();
	let latest = useRef(0);
	useEffect(() => {
		if (query === undefined) return;
		let controller = new AbortController();
		let sequence = ++latest.current;
		let timer = window.setTimeout(() => {
			response<MentionSources>(
				`/api/channels/${encodeURIComponent(room)}/mentions?${new URLSearchParams({ query })}`,
				{ signal: controller.signal },
			).then(sources => {
				if (sequence === latest.current) setHeld({ room, query, sources });
			}, () => {
				if (sequence === latest.current) setHeld(undefined);
			});
		}, DELAY);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [room, query]);
	// Only the answer to this very query: an older one would offer parts the words no longer name,
	// and Enter would choose one.
	return query !== undefined && held?.room === room && held.query === query
		? held.sources
		: undefined;
}
