import { AgentFace, Face } from "@chopin/editor/face";
import { personName } from "@chopin/editor/people";
import { StaticPlanEditor } from "@chopin/editor/static";
import { ArrowLeftIcon, CloseIcon } from "@chopin/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
	documentHistory,
	documentVersion,
	historyAge,
	historyEntries,
	historyExact,
	historyGap,
	missingSummaries,
	requestHistorySummaries,
	restoreDocumentVersion,
	SUMMARIZED_SESSIONS,
} from "./document-history";
import { IconButton } from "./icon-button";

import "./document-history.css";

import type { CSSProperties, MouseEvent } from "react";
import type {
	DocumentHistory,
	DocumentVersionSource,
	DocumentVersionSummary,
	VersionAuthor,
} from "./document-history";

/** How often an open panel looks for sessions others have added. */
const REFRESH_MS = 15_000;

/** A deliberate pause: the row already says who, what and roughly when; this is for lingering. */
const DETAIL_DELAY_MS = 900;

/** While summaries are being written, the list checks for them this often, for this long. */
const SUMMARY_POLL_MS = 2_000;
const SUMMARY_WAIT_MS = 30_000;

function who(author: VersionAuthor | undefined, self: string): string {
	if (!author) return "Chopin";
	return author.login === self ? "You" : personName(author.login);
}

function Mark({ author }: { author?: VersionAuthor }) {
	return author
		? <Face decorative handle={author.login} size={18} textSize="2xs" />
		: <AgentFace size={18} />;
}

type Detail = { label: string; at: string; top: number; left: number };

/**
 * A document's editing sessions, newest first, one line each: who, what, and how long ago, with
 * space between rows growing with the time between them. Lingering on a row shows the full line
 * and the exact time. Choosing an earlier session shows the document as it left it; choosing the
 * newest returns to the live document. It slides over the views bar and document from the right,
 * so nothing beneath reflows, and slides back out before `onClosed`.
 */
export function DocumentHistoryPanel(
	{ channelId, closing, id, onClose, onClosed, onSelect, reload, selected, self }: {
		channelId: string;
		/** Changes when the list should be fetched again now, as after a restore. */
		reload?: number;
		/** Set while the panel slides out; it calls `onClosed` once it has gone. */
		closing?: boolean;
		id: string;
		onClose: () => void;
		onClosed: () => void;
		onSelect: (version: DocumentVersionSummary | undefined) => void;
		/** The earlier session on show, if any. */
		selected?: string;
		self: string;
	},
) {
	let [history, setHistory] = useState<DocumentHistory>();
	let [failed, setFailed] = useState(false);
	let [attempt, setAttempt] = useState(0);
	let [detail, setDetail] = useState<Detail>();
	let timer = useRef<number>(undefined);

	// Rows show at once; summaries the server has not written yet are asked for when History
	// opens, shown as skeletons, and filled in as they arrive.
	let [summarising, setSummarising] = useState(false);
	useEffect(() => {
		let controller = new AbortController();
		let asked = false;
		let waitUntil = 0;
		let poll: number | undefined;
		let load = (): Promise<void> =>
			documentHistory(channelId, controller.signal).then(
				async value => {
					setHistory(value);
					setFailed(false);
					let missing = missingSummaries(value);
					if (!missing || (asked && Date.now() > waitUntil)) {
						window.clearInterval(poll);
						poll = undefined;
						setSummarising(false);
						if (!missing || asked) return;
					}
					if (asked) return;
					asked = true;
					let { state } = await requestHistorySummaries(channelId, controller.signal);
					if (state !== "pending") return;
					waitUntil = Date.now() + SUMMARY_WAIT_MS;
					setSummarising(true);
					poll = window.setInterval(() => void load(), SUMMARY_POLL_MS);
				},
				() => {
					if (!controller.signal.aborted) {
						setFailed(true);
						setSummarising(false);
					}
				},
			);
		void load();
		let refresh = window.setInterval(load, REFRESH_MS);
		return () => {
			controller.abort();
			window.clearInterval(refresh);
			window.clearInterval(poll);
		};
	}, [attempt, channelId, reload]);

	let hideDetail = useCallback(() => {
		window.clearTimeout(timer.current);
		setDetail(undefined);
	}, []);
	useEffect(() => {
		window.addEventListener("scroll", hideDetail, { capture: true, passive: true });
		return () => {
			window.removeEventListener("scroll", hideDetail, { capture: true });
			window.clearTimeout(timer.current);
		};
	}, [hideDetail]);

	let now = new Date();
	let entries = history ? historyEntries(history) : [];
	let lingerOn = (label: string, at: string) => (event: MouseEvent<HTMLElement>) => {
		let row = event.currentTarget.getBoundingClientRect();
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(
			() => setDetail({ label, at, top: row.top + row.height / 2, left: row.left }),
			DETAIL_DELAY_MS,
		);
	};

	return (
		<aside
			aria-labelledby={`${id}-heading`}
			className="history-sidebar"
			data-closing={closing ? "" : undefined}
			id={id}
			onAnimationEnd={event => {
				if (closing && event.target === event.currentTarget) onClosed();
			}}
		>
			<header className="history-sidebar-header">
				<h2 className="history-sidebar-title" id={`${id}-heading`}>History</h2>
				<IconButton aria-label="Close history" onClick={onClose} size="compact">
					<CloseIcon />
				</IconButton>
			</header>
			<div className="history-sidebar-body" data-history-scroll>
				{failed && !history && (
					<p className="history-note">
						History could not load.{" "}
						<button
							className="btn btn-compact btn-outline"
							onClick={() => setAttempt(count => count + 1)}
							type="button"
						>
							Retry
						</button>
					</p>
				)}
				{!history && !failed && <p className="history-note">Loading history…</p>}
				<ol className="history-entries">
					{entries.map((entry, index) => {
						let gap = index === 0 ? 0 : historyGap(entries[index - 1]!.at, entry.at);
						let style = { "--history-gap": gap } as CSSProperties;
						if (entry.kind === "created") {
							let name = entry.author ? who(entry.author, self) : "Someone";
							return (
								<li key="created" style={style}>
									<div
										className="history-entry"
										data-event=""
										onMouseEnter={lingerOn(`${name} created the document`, entry.at)}
										onMouseLeave={hideDetail}
									>
										<Mark {...(entry.author ? { author: entry.author } : {})} />
										<span className="history-entry-who">{name}</span>
										<span className="history-entry-what">created the document</span>
										<time className="history-entry-when" dateTime={entry.at}>
											{historyAge(entry.at, now)}
										</time>
									</div>
								</li>
							);
						}
						let name = who(entry.version.author, self);
						let current = entry.current ? !selected : selected === entry.version.id;
						let what = entry.version.summary ?? "made edits";
						let pending = !entry.version.summary && summarising && index < SUMMARIZED_SESSIONS;
						return (
							<li key={entry.version.id} style={style}>
								<button
									aria-current={current || undefined}
									className="history-entry"
									onClick={() => onSelect(entry.current ? undefined : entry.version)}
									onMouseEnter={lingerOn(entry.version.summary ?? `${name} made edits`, entry.at)}
									onMouseLeave={hideDetail}
									type="button"
								>
									<Mark {...(entry.version.author ? { author: entry.version.author } : {})} />
									<span className="history-entry-who">{name}</span>
									{pending
										? <span aria-label="Summarising" className="history-entry-skeleton" />
										: <span className="history-entry-what">{what}</span>}
									<time className="history-entry-when" dateTime={entry.at}>
										{historyAge(entry.at, now)}
									</time>
								</button>
							</li>
						);
					})}
				</ol>
			</div>
			{/* Portalled: the scroller and the slide would otherwise contain a fixed child. */}
			{detail && createPortal(
				<div
					className="history-detail"
					role="tooltip"
					style={{
						"--detail-top": `${detail.top}px`,
						"--detail-left": `${detail.left}px`,
					} as CSSProperties}
				>
					<span>{detail.label}</span>
					<span className="history-detail-when">{historyExact(detail.at, now)}</span>
				</div>,
				document.body,
			)}
		</aside>
	);
}

/**
 * Takes the views bar's place while an earlier session is on show: the way back, whose edits and
 * when. The tabs return with the live document.
 */
export function DocumentVersionBar(
	{ channelId, onBack, onRestored, self, version }: {
		channelId: string;
		onBack: () => void;
		/** Absent for readers, who cannot restore. */
		onRestored?: () => void;
		self: string;
		version: DocumentVersionSummary;
	},
) {
	let [restoring, setRestoring] = useState(false);
	let [failure, setFailure] = useState<string>();
	useEffect(() => setFailure(undefined), [version.id]);
	let name = version.author?.login === self ? "Your edits" : `${who(version.author, self)}’s edits`;
	return (
		<div className="history-version-bar" role="status">
			<button className="btn btn-compact btn-ghost shrink-0" onClick={onBack} type="button">
				<ArrowLeftIcon aria-hidden="true" />
				Current
			</button>
			<span className="history-version-label">
				<strong>{name}</strong>
				<span>{historyExact(version.updatedAt, new Date())}</span>
			</span>
			{onRestored && (
				<button
					aria-busy={restoring || undefined}
					className="btn btn-compact btn-outline shrink-0"
					disabled={restoring}
					onClick={() => {
						setRestoring(true);
						setFailure(undefined);
						restoreDocumentVersion(channelId, version.id).then(
							() => {
								setRestoring(false);
								onRestored();
							},
							(err: unknown) => {
								setRestoring(false);
								setFailure(err instanceof Error ? err.message : "Could not restore.");
							},
						);
					}}
					type="button"
				>
					Restore
				</button>
			)}
			{failure && <span className="history-version-failure">{failure}</span>}
		</div>
	);
}

/** The document as an earlier session left it, read-only, in place of the live one. */
export function DocumentVersionView(
	{ channelId, version }: { channelId: string; version: DocumentVersionSummary },
) {
	let [loaded, setLoaded] = useState<DocumentVersionSource>();
	let [failed, setFailed] = useState(false);

	useEffect(() => {
		let controller = new AbortController();
		setLoaded(undefined);
		setFailed(false);
		documentVersion(channelId, version.id, controller.signal).then(setLoaded, () => {
			if (!controller.signal.aborted) setFailed(true);
		});
		return () => controller.abort();
	}, [channelId, version.id]);

	return (
		<div className="history-version" data-contents-root>
			{failed && <p className="history-note">This version could not load.</p>}
			{loaded && (
				<StaticPlanEditor
					label={`Document as of ${historyExact(version.updatedAt, new Date())}`}
					presentation="pane"
					source={loaded.source}
				/>
			)}
		</div>
	);
}
