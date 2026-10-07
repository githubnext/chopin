import { createRoot } from "react-dom/client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { IconTooltip } from "../icon-tooltip";
import { useMotionInput } from "../motion-input";
import { clampPane, ResizeHandle } from "../resizable-pane";
import { ComposerPreview } from "./composer";
import { ChopinMark } from "./agent-mark";

import "@fontsource-variable/inter/opsz.css";
import "../theme.css";
import "../chat/run-card.css";
import "../icon-tooltip.css";
import "./styles.css";
import "./workspace-styles.css";

function WorkspaceJig() {
	useMotionInput();
	let frame = useRef<HTMLDivElement>(null);
	let [available, setAvailable] = useState(1200);
	let [preferred, setPreferred] = useState(500);
	let [tab, setTab] = useState("chat");
	let [messages, setMessages] = useState<string[]>([]);
	let compact = available < 700;
	let maximum = Math.max(250, available - 450);
	let chat = compact ? available : clampPane(preferred, 250, maximum);
	let documentWidth = compact ? available : available - chat;
	useLayoutEffect(() => {
		let element = frame.current;
		if (!element) return;
		let observer = new ResizeObserver(entries => {
			setAvailable(Math.round(entries[0].contentRect.width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent("workspace-sizing", {
				detail: {
					availableFrame: available,
					preferredChat: preferred,
					renderedChat: chat,
					documentWidth,
				},
			}),
		);
	}, [available, preferred, chat, documentWidth]);
	return (
		<main className="jig-page workspace-jig-page">
			<IconTooltip />
			<header className="jig-header">
				<p className="eyebrow">Chopin / layout</p>
				<h1>Workspace sizing</h1>
				<p>Drag the divider to resize Chat. Use Dial Kit to change the available frame.</p>
				<a className="workspace-composer-link" href="../composer/">Composer states</a>
			</header>
			<section className="workspace-jig-panel" aria-label="Workspace preview">
				<div className="workspace-preview-toolbar">
					<strong>Export formats</strong>
					{compact && (
						<div
							role="tablist"
							aria-label="Workspace pane"
							onKeyDown={event => {
								if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
								let next = event.key === "Home" ? "document" : event.key === "End"
									? "chat"
									: tab === "chat"
									? "document"
									: "chat";
								setTab(next);
								document.getElementById(`workspace-tab-${next}`)?.focus();
								event.preventDefault();
							}}
						>
							{["document", "chat"].map(pane => (
								<button
									key={pane}
									role="tab"
									aria-selected={tab === pane}
									id={`workspace-tab-${pane}`}
									aria-controls={`workspace-pane-${pane}`}
									tabIndex={tab === pane ? 0 : -1}
									onClick={() => setTab(pane)}
									className="btn btn-sm btn-ghost"
								>
									{pane === "chat" ? "Chat" : "Document"}
								</button>
							))}
						</div>
					)}
				</div>
				<div
					className="workspace-preview-frame"
					ref={frame}
					data-compact={compact || undefined}
					style={{ gridTemplateColumns: `minmax(0, 1fr) ${chat}px` }}
				>
					<article
						className="workspace-preview-document"
						hidden={compact && tab !== "document"}
						id="workspace-pane-document"
						role={compact ? "tabpanel" : undefined}
						aria-labelledby={compact ? "workspace-tab-document" : undefined}
					>
						<p className="eyebrow">Document</p>
						<h2>Export formats</h2>
						<p>Make documents easy to share, while preserving their structure and decisions.</p>
						<h3>Markdown</h3>
						<p>Export readable text with headings, tables, and links to related documents.</p>
						<h3>PDF</h3>
						<p>Use a clean page layout for documents that people will read or print.</p>
					</article>
					<section
						className="workspace-preview-chat"
						aria-label="Chat pane"
						hidden={compact && tab !== "chat"}
						id="workspace-pane-chat"
						role={compact ? "tabpanel" : undefined}
						aria-labelledby={compact ? "workspace-tab-chat" : undefined}
					>
						{!compact && (
							<ResizeHandle
								label="Resize Chat"
								min={250}
								max={maximum}
								width={chat}
								side="left"
								onResize={delta => setPreferred(clampPane(chat + delta, 250, maximum))}
							/>
						)}
						<header>Chat</header>
						<div className="workspace-preview-conversation">
							<p>
								<strong>Maggie</strong>Could you outline the export options?
							</p>
							<p className="agent-example">
								<strong>
									<ChopinMark circle />Chopin
								</strong>
								I’ve added Markdown and PDF options to the document.
							</p>
							{messages.map((message, index) => (
								<p key={index}>
									<strong>You</strong>
									{message}
								</p>
							))}
						</div>
						<div className="workspace-preview-composer">
							<ComposerPreview
								scenario="chopin"
								onSend={text => setMessages(current => [...current, text])}
							/>
						</div>
					</section>
				</div>
			</section>
			<footer className="jig-footer workspace-sizing-footer">
				<p data-workspace-widths>
					Frame {available}px · Chat {chat}px · Document {documentWidth}px · preferred Chat{" "}
					{preferred}px
				</p>
				<button className="btn btn-sm btn-secondary" onClick={() => setPreferred(500)}>
					Reset to 500px
				</button>
				<button className="btn btn-sm btn-primary" id="workspace-copy-values">Copy values</button>
				<span id="workspace-copy-status" role="status" />
			</footer>
			<textarea
				className="field copy-output"
				id="workspace-values-output"
				aria-label="Chosen workspace values"
				readOnly
				hidden
			/>
			<p className="jig-note">
				Chat minimum 250px · Document minimum 450px · single pane below 700px
			</p>
		</main>
	);
}

createRoot(document.getElementById("jig-root")!).render(<WorkspaceJig />);
