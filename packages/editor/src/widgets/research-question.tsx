import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useCellValue } from "@mdxeditor/gurx";
import {
	$getSelection,
	$isElementNode,
	$nodesOfType,
	COMMAND_PRIORITY_HIGH,
	COPY_COMMAND,
	CUT_COMMAND,
	DRAGSTART_COMMAND,
	SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
} from "lexical";
import { ResearchQuestionNode, ULID, ulid } from "@chopin/dialect";

import { canCancelJob, researchJob, useJobs } from "../jobs";
import { widgets$ } from "../widget-options";

import type { JobStore } from "../jobs";
import type { LexicalEditor, LexicalNode } from "lexical";

type ResearchQuestion = { key: string; id: string; question: string };

/** Preserve an explicit move; every ordinary paste creates document-local identity. */
export function normalizeResearchQuestionIds(
	nodes: LexicalNode[],
	preserve: Set<string> = new Set(),
): void {
	let used = new Set($nodesOfType(ResearchQuestionNode).map(node => node.getId()));
	let visit = (node: LexicalNode): void => {
		if (node instanceof ResearchQuestionNode) {
			let id = node.getId();
			let moving = preserve.delete(id) && !used.has(id);
			if (!ULID.test(id) || used.has(id) || !moving) {
				id = ulid();
				node.setId(id);
			}
			used.add(id);
		}
		if ($isElementNode(node)) {
			for (let child of node.getChildren()) visit(child);
		}
	};
	for (let node of nodes) visit(node);
}

function selectedResearchIds(): Set<string> {
	let ids = new Set<string>();
	let selection = $getSelection();
	for (let selected of selection?.getNodes() ?? []) {
		let node: LexicalNode | null = selected;
		while (node) {
			if (node instanceof ResearchQuestionNode) ids.add(node.getId());
			node = node.getParent();
		}
	}
	return ids;
}

export function collectResearchQuestions(editor: LexicalEditor): ResearchQuestion[] {
	return editor.getEditorState().read(() =>
		$nodesOfType(ResearchQuestionNode).map(node => ({
			key: node.getKey(),
			id: node.getId(),
			question: node.getTextContent().replace(/\s+/g, " ").trim(),
		}))
	);
}

function report(value: unknown): {
	title: string;
	summary: string;
	findings: Array<{ text: string; sourceUrls: string[] }>;
	sources: Array<{ title: string; url: string }>;
	question: string;
	caveats: string[];
	documentRevision: number;
	documentSourceHash: string;
} | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let artifact = value as Record<string, unknown>;
	let body = artifact.report;
	if (
		!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(artifact.sources)
	) {
		return undefined;
	}
	let valueBody = body as Record<string, unknown>;
	if (
		typeof valueBody.title !== "string"
		|| typeof valueBody.summary !== "string"
		|| !Array.isArray(valueBody.findings)
		|| !Array.isArray(valueBody.caveats)
		|| typeof artifact.question !== "string"
		|| typeof artifact.documentRevision !== "number"
		|| typeof artifact.documentSourceHash !== "string"
	) return undefined;
	let findings = valueBody.findings.flatMap(item => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		let finding = item as Record<string, unknown>;
		return typeof finding.text === "string" && Array.isArray(finding.sourceUrls)
			? [{
				text: finding.text,
				sourceUrls: finding.sourceUrls.filter((url): url is string => typeof url === "string"),
			}]
			: [];
	});
	let sources = artifact.sources.flatMap(item => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		let source = item as Record<string, unknown>;
		if (typeof source.title !== "string" || typeof source.url !== "string") return [];
		try {
			let url = new URL(source.url);
			return url.protocol === "https:" ? [{ title: source.title, url: url.toString() }] : [];
		} catch {
			return [];
		}
	});
	return {
		title: valueBody.title,
		summary: valueBody.summary,
		findings,
		sources,
		question: artifact.question,
		caveats: valueBody.caveats.filter((value): value is string => typeof value === "string"),
		documentRevision: artifact.documentRevision,
		documentSourceHash: artifact.documentSourceHash,
	};
}

function Chrome(
	{ assignable, connected, editable, question, store }: {
		assignable: boolean;
		connected: boolean;
		editable: boolean;
		question: ResearchQuestion;
		store: JobStore;
	},
) {
	let snapshot = useJobs(store);
	let job = researchJob(snapshot.jobs, question.id);
	let [expanded, setExpanded] = useState(false);
	let [error, setError] = useState<string>();
	let detail = job ? snapshot.details[job.id] : undefined;
	let result = detail?.artifact && report(detail.artifact.value);
	let stale = !!result
		&& (result.question.replace(/\s+/g, " ").trim() !== question.question
			|| detail?.currentTargetGeneration !== job?.targetGeneration);
	if (!snapshot.ready) return null;
	let assign = (requestKey = "initial") => {
		setError(undefined);
		void store.assignResearch(question.id, requestKey).catch(err =>
			setError(err instanceof Error ? err.message : "Could not assign research.")
		);
	};
	let cancel = () => {
		if (!job) return;
		setError(undefined);
		void store.cancel(job).catch(err =>
			setError(err instanceof Error ? err.message : "Could not cancel research.")
		);
	};
	let open = () => {
		setExpanded(value => !value);
		if (job && !detail) void store.detail(job.id).catch(() => {});
	};
	let terminal = job
		&& (job.state === "failed" || job.state === "cancelled" || job.state === "superseded");
	let canAssign = !job || !!terminal || job?.state === "completed" && stale;
	let unavailable = !connected || snapshot.refreshing || snapshot.pending[question.id] === "assign";
	return (
		<div className="plan-research-derived" aria-live="polite">
			<p className="plan-research-disclosure">
				Public search receives this question text. Private document context is analyzed separately
				without web access.
			</p>
			{canAssign && editable && assignable && (
				<button
					data-press="wide"
					disabled={unavailable || !question.question}
					onClick={() => assign(job?.id ?? "initial")}
					type="button"
				>
					{snapshot.pending[question.id] === "assign"
						? "Assigning…"
						: job
						? "Research again"
						: "Assign research"}
				</button>
			)}
			{job && (
				<div className="plan-research-status">
					<span>Research: {job.state}{job.reason ? ` (${job.reason})` : ""}</span>
					{editable && canCancelJob(job) && (
						<button
							data-press="wide"
							disabled={!connected || snapshot.refreshing || !!snapshot.pending[job.id]}
							onClick={cancel}
							type="button"
						>
							Cancel
						</button>
					)}
					{job.state === "completed" && (
						<button aria-expanded={expanded} data-press="wide" onClick={open} type="button">
							{expanded ? "Hide report" : "Read report"}
						</button>
					)}
				</div>
			)}
			{expanded && result && (
				<article className="plan-research-report">
					{stale && (
						<p>
							<strong>This report answers an earlier question or document revision.</strong>
						</p>
					)}
					<h4>{result.title}</h4>
					<p>Based on document revision {result.documentRevision}.</p>
					<p>{result.summary}</p>
					<ul>{result.findings.map((finding, index) => <li key={index}>{finding.text}</li>)}</ul>
					{result.sources.length > 0 && (
						<ul>
							{result.sources.map(source => (
								<li key={source.url}>
									<a href={source.url} rel="noopener noreferrer" target="_blank">{source.title}</a>
								</li>
							))}
						</ul>
					)}
					{result.caveats.length > 0 && (
						<div>
							<strong>Caveats</strong>
							<ul>{result.caveats.map(value => <li key={value}>{value}</li>)}</ul>
						</div>
					)}
				</article>
			)}
			{expanded && detail && !result && <p>Research report is unavailable.</p>}
			{error && <p className="plan-research-error">{error}</p>}
		</div>
	);
}

export function ResearchQuestionPlugin() {
	let [editor] = useLexicalComposerContext();
	let options = useCellValue(widgets$);
	let [questions, setQuestions] = useState<ResearchQuestion[]>([]);
	let moving = useRef(new Set<string>());
	useEffect(() => {
		let update = () => setQuestions(collectResearchQuestions(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);
	useEffect(() => {
		let copy = editor.registerCommand(
			COPY_COMMAND,
			() => {
				moving.current.clear();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let cut = editor.registerCommand(
			CUT_COMMAND,
			() => {
				moving.current = selectedResearchIds();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let drag = editor.registerCommand(
			DRAGSTART_COMMAND,
			() => {
				moving.current = selectedResearchIds();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		let insert = editor.registerCommand(
			SELECTION_INSERT_CLIPBOARD_NODES_COMMAND,
			payload => {
				normalizeResearchQuestionIds(payload.nodes, moving.current);
				moving.current.clear();
				return false;
			},
			COMMAND_PRIORITY_HIGH,
		);
		return () => {
			copy();
			cut();
			drag();
			insert();
		};
	}, [editor]);
	let store = options.jobs;
	if (!store) return null;
	return (
		<>
			{questions.map(question => {
				let host = editor.getElementByKey(question.key)
					?.querySelector<HTMLElement>("[data-plan-research-question-derived]");
				return host
					? createPortal(
						<Chrome
							assignable={!!options.canAssignJobs}
							connected={!!options.connected}
							editable={!!options.canEdit}
							question={question}
							store={store}
						/>,
						host,
						question.key,
					)
					: null;
			})}
		</>
	);
}
