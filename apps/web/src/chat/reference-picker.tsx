import { useEffect, useRef, useState } from "react";

import * as Api from "../api";
import { MAX_REFERENCES, referenceTriggerKey } from "./references";

import type { ReferenceTarget, ReferenceTrigger } from "./references";

const SEARCH_DELAY = 160;

export type ReferenceSearchApi = Pick<
	typeof Api,
	"channelResearchWorkspaces" | "channels"
>;

export type ReferencePickerRequest = {
	id: number;
	key: string;
	controller: AbortController;
};

export type ReferencePickerState =
	| { status: "idle" | "loading" | "limit"; options: ReferenceTarget[] }
	| { status: "ready"; options: ReferenceTarget[]; truncated?: boolean }
	| { status: "error"; options: ReferenceTarget[]; error: unknown };

export type ReferenceSearchResult = { options: ReferenceTarget[]; truncated: boolean };

type LoadedPickerState = ReferencePickerState & { key: string };

export function currentReferencePickerRequest(
	current: ReferencePickerRequest | undefined,
	candidate: ReferencePickerRequest,
): boolean {
	return current === candidate && !candidate.controller.signal.aborted;
}

export function referencePickerRequestKey(
	trigger: ReferenceTrigger,
	repository: Pick<Api.Repository, "id" | "owner" | "name">,
	room: string,
): string {
	return JSON.stringify([
		repository.id,
		repository.owner,
		repository.name,
		room,
		referenceTriggerKey(trigger),
	]);
}

export type ReferencePickerKeyAction = "dismiss" | "next" | "previous" | "select";

export function referencePickerKeyAction(
	event: { key: string; keyCode?: number; isComposing?: boolean; shiftKey?: boolean },
	selectable: boolean,
): ReferencePickerKeyAction | undefined {
	if (event.isComposing || event.keyCode === 229) return undefined;
	if (event.key === "Escape") return "dismiss";
	if (!selectable) return undefined;
	if (event.key === "ArrowDown") return "next";
	if (event.key === "ArrowUp") return "previous";
	if (event.key === "Enter" && !event.shiftKey) return "select";
	return undefined;
}

export async function searchReferenceTargets(
	trigger: ReferenceTrigger,
	repository: Pick<Api.Repository, "id" | "owner" | "name">,
	room: string,
	signal: AbortSignal,
	api: ReferenceSearchApi = Api,
): Promise<ReferenceSearchResult> {
	if (trigger.kind === "document") {
		let channels = new Map<string, Api.Channel>();
		let cursor: string | undefined;
		let pages = 0;
		let omitted = false;
		do {
			let page = await api.channels(
				repository.owner,
				repository.name,
				cursor,
				trigger.query || undefined,
				signal,
			);
			for (let [index, channel] of page.channels.entries()) {
				if (channel.id !== room) channels.set(channel.id, channel);
				if (channels.size >= MAX_REFERENCES) {
					omitted = index < page.channels.length - 1;
					break;
				}
			}
			cursor = page.nextCursor;
			pages++;
		} while (channels.size < MAX_REFERENCES && cursor && pages < 5);
		return {
			options: [...channels.values()].slice(0, MAX_REFERENCES).map(channel => ({
				kind: "document" as const,
				channelId: channel.id,
				title: channel.title,
				slug: channel.slug,
			})),
			truncated: omitted || !!cursor,
		};
	}

	let page = await api.channelResearchWorkspaces(room, signal);
	let query = trigger.query.toLowerCase();
	return {
		options: page.workspaces
			.filter(workspace => !query || workspace.title.toLowerCase().includes(query))
			.slice(0, MAX_REFERENCES)
			.map(workspace => ({
				kind: "research" as const,
				workspaceId: workspace.id,
				title: workspace.title,
				discriminator: workspace.id.slice(-8),
			})),
		truncated: page.truncated,
	};
}

export function useReferencePicker(
	trigger: ReferenceTrigger | undefined,
	repository: Pick<Api.Repository, "id" | "owner" | "name">,
	room: string,
): ReferencePickerState & {
	active: number;
	setActive: (active: number | ((current: number) => number)) => void;
} {
	let sequence = useRef(0);
	let request = useRef<ReferencePickerRequest | undefined>(undefined);
	let [active, setActive] = useState(0);
	let [loaded, setLoaded] = useState<LoadedPickerState>({
		key: "",
		status: "idle",
		options: [],
	});
	let key = trigger ? referencePickerRequestKey(trigger, repository, room) : "";
	let triggerKind = trigger?.kind;
	let triggerMarker = trigger?.marker;
	let triggerQuery = trigger?.query;
	let triggerStart = trigger?.start;
	let triggerEnd = trigger?.end;

	useEffect(() => {
		if (
			triggerKind === undefined
			|| triggerMarker === undefined
			|| triggerQuery === undefined
			|| triggerStart === undefined
			|| triggerEnd === undefined
		) return;
		let selected: ReferenceTrigger = {
			kind: triggerKind,
			marker: triggerMarker,
			query: triggerQuery,
			start: triggerStart,
			end: triggerEnd,
		};
		let candidate = {
			id: ++sequence.current,
			key,
			controller: new AbortController(),
		};
		request.current = candidate;
		setActive(0);
		setLoaded({ key, status: "loading", options: [] });
		let timer = window.setTimeout(() => {
			void searchReferenceTargets(
				selected,
				repository,
				room,
				candidate.controller.signal,
			).then(result => {
				if (!currentReferencePickerRequest(request.current, candidate)) return;
				setLoaded({ key, status: "ready", ...result });
			}, error => {
				if (!currentReferencePickerRequest(request.current, candidate)) return;
				setLoaded({ key, status: "error", options: [], error });
			});
		}, SEARCH_DELAY);
		return () => {
			window.clearTimeout(timer);
			candidate.controller.abort();
			if (request.current === candidate) request.current = undefined;
		};
	}, [
		key,
		repository.id,
		repository.name,
		repository.owner,
		room,
		triggerEnd,
		triggerKind,
		triggerMarker,
		triggerQuery,
		triggerStart,
	]);

	if (!trigger) return { status: "idle", options: [], active, setActive };
	if (request.current?.key !== key || loaded.key !== key) {
		return { status: "loading", options: [], active: 0, setActive };
	}
	return { ...loaded, active, setActive };
}

export function referenceOptionId(listId: string, index: number): string {
	return `${listId}-option-${index}`;
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Could not load references.";
}

export function ReferencePicker(
	{
		active,
		id,
		kind,
		onActive,
		onSelect,
		state,
	}: {
		active: number;
		id: string;
		kind: ReferenceTrigger["kind"];
		onActive: (index: number) => void;
		onSelect: (target: ReferenceTarget) => void;
		state: ReferencePickerState;
	},
) {
	let documentReference = kind === "document";
	let label = documentReference ? "Document references" : "Research Workspace references";
	let marker = documentReference ? "#" : "%";
	let empty = state.status === "ready" && state.truncated
		? `No matches in the available ${documentReference ? "documents" : "Research Workspaces"}.`
		: documentReference
		? "No matching documents."
		: "No matching Research Workspaces.";

	useEffect(() => {
		if (state.options.length === 0) return;
		let frame = requestAnimationFrame(() => {
			document.getElementById(referenceOptionId(id, active))?.scrollIntoView({ block: "nearest" });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, id, state.options.length]);

	return (
		<div
			className="absolute inset-x-2.5 bottom-full z-30 mb-1 overflow-y-auto rounded-lg bg-page p-1 ring-hairline shadow-overlay"
			data-chat-reference-picker={kind}
			data-focus-boundary=""
			style={{ maxHeight: "min(16rem, 45dvh, 45vh)" }}
		>
			<div aria-busy={state.status === "loading"} aria-label={label} id={id} role="listbox">
				{state.status === "loading" && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading {documentReference ? "documents" : "Research Workspaces"}...
					</p>
				)}
				{state.status === "limit" && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						A message can include up to 10 references.
					</p>
				)}
				{state.status === "error" && (
					<p className="px-2 py-3 text-sm text-destructive-ink" role="alert">
						{failureMessage(state.error)}
					</p>
				)}
				{state.status === "ready" && state.options.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">{empty}</p>
				)}
				{state.status === "ready" && state.truncated && (
					<p className="px-2 py-2 text-sm text-text-tertiary" role="status">
						Some {documentReference ? "documents" : "Research Workspaces"} are not shown.
					</p>
				)}
				{state.options.map((option, index) => {
					let description = option.kind === "document" && option.slug
						? `${referenceOptionId(id, index)}-description`
						: undefined;
					return (
						<button
							aria-describedby={description}
							aria-label={option.kind === "research"
								? `${option.title}, workspace ${option.workspaceId}`
								: option.title}
							aria-selected={index === active}
							className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition ${
								index === active ? "bg-selected" : "hover:bg-hover"
							}`}
							id={referenceOptionId(id, index)}
							key={option.kind === "document" ? option.channelId : option.workspaceId}
							onClick={() => onSelect(option)}
							onMouseDown={event => event.preventDefault()}
							onMouseEnter={() => onActive(index)}
							role="option"
							tabIndex={-1}
							type="button"
						>
							<span aria-hidden="true" className="shrink-0 text-text-quaternary">{marker}</span>
							<span className="min-w-0 flex-1 truncate text-sm font-medium">{option.title}</span>
							{option.kind === "research" && (
								<span className="shrink-0 font-mono text-sm text-text-quaternary">
									...{option.discriminator}
								</span>
							)}
							{option.kind === "document" && option.slug && (
								<span className="shrink-0 font-mono text-sm text-text-quaternary" id={description}>
									{option.slug}
								</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}
