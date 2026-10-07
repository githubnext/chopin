import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { AgentFace } from "@chopin/editor";
import { Chat } from "../chat/chat";
import { IconTooltip } from "../icon-tooltip";
import { ComposerPreview } from "./composer";
import { ChopinMark } from "./agent-mark";
import { useMotionInput } from "../motion-input";
import { StatusInventory } from "./status-inventory";
import { scenarios } from "./scenarios";
import type { Scenario } from "./scenarios";
import type { Wire } from "../wire";
import "@fontsource-variable/inter/opsz.css";
import "../theme.css";
import "../chat/run-card.css";
import "../icon-tooltip.css";
import "./styles.css";

let listeners = new Map<string, Set<(frame: unknown) => void>>();
let mockWire = {
	on(kind: string, listener: (frame: unknown) => void) {
		let set = listeners.get(kind) ?? new Set();
		set.add(listener);
		listeners.set(kind, set);
		if (kind === "chat:history") {
			queueMicrotask(() => listener({ entries: [], queued: [], busy: false, runs: [] }));
		}
		return () => set.delete(listener);
	},
	send() {},
	async ask(_kind: string, payload: { text: string }) {
		for (let listener of listeners.get("chat:message") ?? []) {
			listener({
				entry: {
					id: crypto.randomUUID(),
					author: { kind: "member", handle: "maggieappleton" },
					text: payload.text,
					ts: Date.now(),
				},
			});
		}
		return {};
	},
} as unknown as Wire;

function JigPage() {
	useMotionInput();
	let [scenario, setScenario] = useState<Scenario>("chopin-draft");
	let [stayInMode, setStayInMode] = useState(true);
	let [messages, setMessages] = useState<{ text: string; destination: string }[]>([]);
	let [revision, setRevision] = useState(0);
	useEffect(() => {
		let update = (event: Event) =>
			setStayInMode((event as CustomEvent).detail.Behaviour.stayInMode);
		window.addEventListener("composer-controls", update);
		return () => window.removeEventListener("composer-controls", update);
	}, []);
	let selection = scenarios.find(item => item[0] === scenario)!;
	return (
		<main className="jig-page">
			<IconTooltip />
			<header className="jig-header">
				<p className="eyebrow">Chopin / interaction design</p>
				<h1>Chat composer</h1>
				<p>
					Click into the adjusted composer and press <kbd>Shift + Tab</kbd>{" "}
					to talk to Chopin. Tune it with the floating Dial Kit panel; every state is below.
				</p>
				<a className="btn btn-sm btn-outline" href="/design-jig/workspace/">Workspace sizing</a>
			</header>
			<section className="jig-panel" aria-label="Current and adjusted composer">
				<div className="panel-heading">
					<div>
						<h2>Try the composer</h2>
						<p>{selection[2]}</p>
					</div>
					<select
						aria-label="Preview state"
						value={scenario}
						className="field"
						onChange={event => {
							setScenario(event.target.value as Scenario);
							setMessages([]);
						}}
					>
						{scenarios.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
					</select>
				</div>
				<div className="comparison">
					<div className="sample current">
						<h3>
							Current <span>Live Chopin component</span>
						</h3>
						<div className="chat-context">
							<p>
								<strong>Maggie</strong> We should keep the first export simple.
							</p>
							<p>
								<strong>Matt</strong> Markdown seems like a good start.
							</p>
							<p className="agent-example">
								<strong>
									<AgentFace size={24} />Chopin
								</strong>
								I can outline a small Markdown export first.
							</p>
						</div>
						<div className="current-chat">
							<Chat
								wire={mockWire}
								handle="maggieappleton"
								connected={true}
								repository={{ id: "jig", owner: "githubnext", name: "chopin" }}
								room="jig"
								referencesEnabled={false}
								sendAcknowledgements={true}
							/>
						</div>
					</div>
					<div className="sample adjusted">
						<h3>
							Adjusted <span>Ace interactions, Chopin styles</span>
						</h3>
						<div className="chat-context">
							<p>
								<strong>Maggie</strong> We should keep the first export simple.
							</p>
							<p>
								<strong>Matt</strong> Markdown seems like a good start.
							</p>
							<p className="agent-example">
								<strong>
									<ChopinMark circle />Chopin
								</strong>
								I can outline a small Markdown export first.
							</p>
							{messages.map((message, index) => (
								<p className="sent-message" key={index}>
									<strong>
										Maggie{message.destination === "planner" && (
											<span className="sent-to">
												<ChopinMark /> to Chopin
											</span>
										)}
									</strong>
									{message.text.replace(/^@chopin\s*/i, "")}
								</p>
							))}
						</div>
						<ComposerPreview
							key={`${scenario}-${revision}`}
							scenario={scenario}
							stayInMode={stayInMode}
							onSend={(text, destination) =>
								setMessages(current => [...current, { text, destination }])}
						/>
					</div>
				</div>
				<div className="jig-footer">
					<p id="chosen-values">360px wide · 12px inset · 64px input · glow 40% / 10px</p>
					<button
						className="btn btn-sm btn-outline"
						onClick={() => {
							setRevision(value => value + 1);
							setMessages([]);
						}}
					>
						Reset preview
					</button>
					<button className="btn btn-sm btn-outline" id="copy-values">Copy values</button>
					<span id="copy-status" role="status" />
				</div>
				<textarea
					id="values-output"
					className="field copy-output"
					aria-label="Chosen values to copy"
					readOnly
					hidden
				/>
				<p className="jig-note">
					Local simulation: sends and reconnects never contact the server. The left composer is the
					real current component; the right reuses Chopin’s SendAction, AgentFace, icons, pickers,
					reference helpers, and tokens.
				</p>
			</section>
			<StatusInventory
				onPreview={next => {
					setScenario(next);
					setMessages([]);
					setRevision(value => value + 1);
					document.querySelector(".jig-panel")?.scrollIntoView({ block: "start" });
				}}
			/>
			<section className="jig-plan" aria-label="Integration plan">
				<h2>What comes across from Ace</h2>
				<div className="plan-columns">
					<div>
						<h3>Bring over</h3>
						<p>
							Persistent mode, automatic agent prefix, accented boundary, compact footer, growing
							input, and separate send / stop controls.
						</p>
					</div>
					<div>
						<h3>Keep from Chopin</h3>
						<p>
							Document references, people mentions, queued turns, stop / resume, server
							acknowledgement, retained drafts, and permission checks.
						</p>
					</div>
					<div>
						<h3>Later decisions</h3>
						<p>
							Rich formatting, attachments, voice input, model selection, and message editing need
							separate product and server support.
						</p>
					</div>
				</div>
				<p className="jig-note">
					Ace currently uses Escape to exit its mode and double Escape to enter it. This proposal
					uses your requested Shift+Tab. Escape dismisses a picker first, then exits Chopin mode.
					Tab still moves focus normally.
				</p>
				<ol>
					<li>
						Extract the composer view while keeping Chat’s draft, reference, and send lifecycle.
					</li>
					<li>
						Add the explicit destination toggle and prefix; translate it into the existing planner /
						room payload.
					</li>
					<li>
						Apply the reviewed styles, then verify keyboard, queue, retry, and reconnect behaviour
						in the browser.
					</li>
				</ol>
			</section>
			<section aria-label="All composer states" className="gallery-section">
				<div className="gallery-heading">
					<h2>Every state, in one place</h2>
					<p>25 live examples. Focus, type, hover, and click.</p>
				</div>
				<div className="state-gallery">
					{scenarios.map(([id, label, note], index) => (
						<article className="state-card" key={id}>
							<header>
								<span className="state-number">{String(index + 1).padStart(2, "0")}</span>
								<div>
									<h3>{label}</h3>
									<p>{note}</p>
								</div>
							</header>
							<ComposerPreview scenario={id} stayInMode={stayInMode} />
						</article>
					))}
				</div>
			</section>
			<footer className="page-end">
				Shift+Tab changes destination only inside an editable composer. A mode label carries the
				same information as the glow.
			</footer>
		</main>
	);
}

createRoot(document.getElementById("jig-root")!).render(<JigPage />);
