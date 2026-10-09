/**
 * GitHub pull request and issue links, drawn as state pills.
 *
 * The document keeps an ordinary Markdown link. The pill is decoration over
 * Lexical's own `<a>`: data attributes the stylesheet reads, never extra DOM,
 * so caret editing, collaboration and the server's headless mirror see the
 * same link they always did.
 *
 * The number is drawn by the stylesheet from `data-gh-number`, beside the
 * authored text rather than inside it. One text run cannot be both truncated
 * (the title) and kept whole and quieter (the number); a generated suffix can.
 * Text that already ends in the same `#N` gets no suffix, so `owner/repo#12`
 * never reads `owner/repo#12 #12`.
 *
 * Pasting a bare pull request or issue URL on its own makes a titled link. The
 * link goes in at once, at the caret the paste was aimed at, titled from the
 * host's cache when it can be and `owner/repo#N` otherwise. If the title
 * arrives shortly after, it replaces that fallback only while the link is
 * still exactly as inserted: same node, same URL, the fallback text untouched,
 * and this editor's caret not inside it. Anything else keeps the fallback. Links
 * already in the document are never retitled.
 */

import { createContext, useContext, useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createLinkNode,
	$isAutoLinkNode,
	$isLinkNode,
	AutoLinkNode,
	LinkNode,
} from "@lexical/link";
import {
	$addUpdateTag,
	$createTextNode,
	$findMatchingParent,
	$getNodeByKey,
	$getSelection,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_CRITICAL,
	COMMAND_PRIORITY_HIGH,
	KEY_DOWN_COMMAND,
	mergeRegister,
	PASTE_COMMAND,
	PASTE_TAG,
} from "lexical";
import { $isCodeBlockNode, $isMathNode } from "@chopin/dialect";
import { parseGitHubReference } from "@chopin/protocol/github-reference";

import { isPlainPasteKey } from "./markdown-paste";

import type { BaseSelection, LexicalEditor, LexicalNode, NodeKey, NodeMutation } from "lexical";
import type {
	GitHubReference,
	GitHubReferenceKind,
	GitHubReferenceResult,
} from "@chopin/protocol/github-reference";
import type { GitHubReferenceEntry, GitHubReferenceStore } from "./widget-options";

export type GitHubPillState =
	| "pr-open"
	| "pr-merged"
	| "pr-closed"
	| "pr-draft"
	| "issue-open"
	| "issue-completed"
	| "issue-not-planned"
	| "loading"
	| "unavailable"
	| "unknown";

/** How long a paste waits for its title before keeping the fallback text for good. */
export const PASTE_TITLE_WINDOW = 5_000;

export function pillState(entry: GitHubReferenceEntry): GitHubPillState {
	if (entry.status === "loading") return "loading";
	if (entry.status === "unavailable") return "unavailable";
	if (entry.status === "rate-limited") return "unknown";
	let summary = entry.summary;
	if (summary.kind === "pull") {
		if (summary.state === "merged") return "pr-merged";
		if (summary.state === "closed") return "pr-closed";
		return summary.draft ? "pr-draft" : "pr-open";
	}
	if (summary.state === "open") return "issue-open";
	return summary.stateReason === "not_planned" ? "issue-not-planned" : "issue-completed";
}

const STATE_WORDS: Record<GitHubPillState, string> = {
	"pr-open": "open",
	"pr-merged": "merged",
	"pr-closed": "closed",
	"pr-draft": "draft",
	"issue-open": "open",
	"issue-completed": "completed",
	"issue-not-planned": "not planned",
	loading: "loading",
	unavailable: "no access",
	unknown: "status unavailable",
};

/** The authored text already ends with this reference's number. */
export function endsWithNumber(text: string, number: number): boolean {
	return new RegExp(`#\\s*${number}\\s*$`).test(text);
}

/** What a pill says to assistive technology, e.g. "Pull request: Fix tables #12, merged". */
export function pillName(
	kind: GitHubReferenceKind,
	text: string,
	number: number,
	state: GitHubPillState,
): string {
	let noun = kind === "pull" ? "Pull request" : "Issue";
	let label = text.trim();
	if (!endsWithNumber(label, number)) label = label ? `${label} #${number}` : `#${number}`;
	return `${noun}: ${label}, ${STATE_WORDS[state]}`;
}

/** The text a pasted reference gets when no title is to hand. */
export function fallbackLabel(reference: GitHubReference): string {
	return `${reference.owner}/${reference.repository}#${reference.number}`;
}

/** The kind GitHub reports, which wins over the URL: `/pull/5` can redirect to an issue. */
function kindOf(reference: GitHubReference, entry: GitHubReferenceEntry): GitHubReferenceKind {
	return entry.status === "ok" ? entry.summary.kind : reference.kind;
}

type PillData = {
	ghKind?: string;
	ghState?: string;
	ghNumber?: string;
	ghEditing?: string;
};

function put(element: HTMLElement, key: keyof PillData, value: string | undefined): void {
	if (value === undefined) delete element.dataset[key];
	else if (element.dataset[key] !== value) element.dataset[key] = value;
}

/** The pill decoration for one link element, or its removal when the URL is not a reference. */
export function decorate(
	element: HTMLElement,
	url: string,
	text: string,
	editing: boolean,
	store: GitHubReferenceStore,
): void {
	let reference = parseGitHubReference(url);
	let data: PillData = {};
	let name: string | undefined;
	if (reference) {
		let entry = store.get(reference);
		let state = pillState(entry);
		let kind = kindOf(reference, entry);
		data = {
			ghKind: kind,
			ghState: state,
			ghNumber: endsWithNumber(text, reference.number) ? undefined : `#${reference.number}`,
			ghEditing: editing ? "" : undefined,
		};
		name = pillName(kind, text, reference.number, state);
	}
	let was = element.dataset.ghState !== undefined;
	put(element, "ghKind", data.ghKind);
	put(element, "ghState", data.ghState);
	put(element, "ghNumber", data.ghNumber);
	put(element, "ghEditing", data.ghEditing);
	// Lexical sets no label on a link, so the only one to remove is a former pill's.
	if (name !== undefined) {
		if (element.ariaLabel !== name) element.ariaLabel = name;
	} else if (was) element.ariaLabel = null;
}

function $activeLink(selection: BaseSelection | null): NodeKey | undefined {
	if (!$isRangeSelection(selection)) return;
	let anchor = $findMatchingParent(selection.anchor.getNode(), $isLinkNode);
	let focus = $findMatchingParent(selection.focus.getNode(), $isLinkNode);
	return anchor && focus && anchor.is(focus) ? anchor.getKey() : undefined;
}

/** Keep every link's pill attributes current with its URL, text, caret and summary. */
export function registerGitHubPills(
	editor: LexicalEditor,
	store: GitHubReferenceStore,
): () => void {
	let links = new Set<NodeKey>();
	let refresh = () => {
		if (links.size === 0) return;
		editor.getEditorState().read(() => {
			let active = $activeLink($getSelection());
			for (let key of links) {
				let node = $getNodeByKey(key);
				let element = editor.getElementByKey(key);
				if (!$isLinkNode(node) || !element) continue;
				// An autolink someone undid is text again, whatever its URL.
				let url = $isAutoLinkNode(node) && node.getIsUnlinked() ? "" : node.getURL();
				decorate(element, url, node.getTextContent(), key === active, store);
			}
		});
	};
	// Mutations are reported per registered class, and a typed URL becomes an AutoLinkNode.
	let track = (mutations: Map<NodeKey, NodeMutation>) => {
		for (let [key, mutation] of mutations) {
			if (mutation === "destroyed") links.delete(key);
			else links.add(key);
		}
		refresh();
	};
	return mergeRegister(
		editor.registerMutationListener(LinkNode, track),
		editor.hasNode(AutoLinkNode) ? editor.registerMutationListener(AutoLinkNode, track) : () => {},
		// Text and caret changes inside a link do not always mark the link itself.
		editor.registerUpdateListener(refresh),
		store.subscribe(refresh),
	);
}

/** Inside code or maths a pasted URL is text. */
function $literal(node: LexicalNode): boolean {
	if ($isTextNode(node) && node.hasFormat("code")) return true;
	return !!$findMatchingParent(node, value => $isCodeBlockNode(value) || $isMathNode(value));
}

/** The reference a paste carries when it is one bare GitHub URL and nothing else. */
export function pastedReference(
	types: readonly string[],
	text: string,
): { url: string; reference: GitHubReference } | undefined {
	if (types.includes("application/x-lexical-editor") || types.includes("Files")) return;
	let url = text.trim();
	if (!url || /\s/.test(url)) return;
	let reference = parseGitHubReference(url);
	return reference && { url, reference };
}

export function registerGitHubPaste(
	editor: LexicalEditor,
	store: GitHubReferenceStore,
	now: () => number = Date.now,
): () => void {
	let upgrade = (key: NodeKey, url: string, fallback: string, result: GitHubReferenceResult) => {
		if (result.status !== "ok") return;
		let title = result.summary.title.trim();
		if (!title) return;
		editor.update(() => {
			let link = $getNodeByKey(key);
			if (!$isLinkNode(link) || !link.isAttached() || link.getURL() !== url) return;
			let children = link.getChildren();
			let text = children[0];
			if (children.length !== 1 || !$isTextNode(text)) return;
			if (text.getTextContent() !== fallback || text.getFormat() !== 0) return;
			if ($activeLink($getSelection()) === key) return;
			text.setTextContent(title);
		});
	};

	// ⇧⌘V asks for text, and reaches the paste handler looking like any other paste.
	let plain = false;
	return mergeRegister(
		editor.registerCommand(
			KEY_DOWN_COMMAND,
			event => {
				plain = isPlainPasteKey(event);
				return false;
			},
			COMMAND_PRIORITY_CRITICAL,
		),
		editor.registerCommand(
			PASTE_COMMAND,
			event => {
				let literal = plain;
				plain = false;
				if (literal || !(event instanceof ClipboardEvent) || !event.clipboardData) return false;
				let data = event.clipboardData;
				let pasted = pastedReference([...data.types], data.getData("text/plain"));
				if (!pasted) return false;
				let selection = $getSelection();
				if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
				let at = selection.anchor.getNode();
				if ($literal(at) || $findMatchingParent(at, $isLinkNode)) return false;

				let entry = store.get(pasted.reference);
				let fallback = fallbackLabel(pasted.reference);
				let title = entry.status === "ok" ? entry.summary.title.trim() : "";
				let link = $createLinkNode(pasted.url);
				link.append($createTextNode(title || fallback));
				selection.insertNodes([link]);
				link.selectNext(0, 0);
				$addUpdateTag(PASTE_TAG);
				event.preventDefault();

				if (!title && entry.status !== "unavailable") {
					let key = link.getKey();
					let started = now();
					void store.load(pasted.reference).then(
						result => {
							if (now() - started <= PASTE_TITLE_WINDOW) upgrade(key, pasted.url, fallback, result);
						},
						() => {},
					);
				}
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		),
	);
}

/**
 * Where an editor finds the host's summaries.
 *
 * A context rather than an editor prop, so any editor the host wraps (the
 * collaborative one, a read-only one, a static specimen) draws pills without
 * each threading the store through its own options.
 */
const GitHubReferencesContext = createContext<GitHubReferenceStore | undefined>(undefined);

export const GitHubReferencesProvider = GitHubReferencesContext.Provider;

export function useGitHubReferences(): GitHubReferenceStore | undefined {
	return useContext(GitHubReferencesContext);
}

export function GitHubReferencesPlugin() {
	let [editor] = useLexicalComposerContext();
	let store = useGitHubReferences();
	useEffect(() => store && registerGitHubPills(editor, store), [editor, store]);
	useEffect(() => store && registerGitHubPaste(editor, store), [editor, store]);
	return null;
}
