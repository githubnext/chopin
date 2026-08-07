import { useEffect, useMemo, useState } from "react";
import {
	cursor,
	Decisions,
	Face,
	PlanEditor,
	QuestionnaireStore,
	ThreadStore,
	useQuestionnaires,
} from "@chopin/editor";

import { Chat } from "./chat/chat";
import * as Identity from "./identity";
import { Wire } from "./wire";
import { paneId, usePaneOpen, Workspace } from "./workspace";

import type { Session } from "@chopin/protocol";
import type { Status } from "./wire";
import type { Pane } from "./workspace";

/**
 * Claim a handle.
 *
 * Deliberately not a login. The field exists so that two windows are two
 * people, which is the whole of what identity has to achieve here.
 */
function SignIn({ onDone }: { onDone: (handle: string) => void }) {
	let [value, setValue] = useState("");
	let valid = Identity.validHandle(value);

	return (
		<div className="flex h-full items-center justify-center">
			<form
				className="flex w-80 flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					if (!valid) return;
					Identity.remember(value);
					onDone(value);
				}}
			>
				<label className="text-sm font-medium" htmlFor="handle">GitHub handle</label>
				<input
					autoFocus
					className="field px-3 py-2 text-sm"
					id="handle"
					onChange={event => setValue(event.target.value.trim())}
					placeholder="octocat"
					value={value}
				/>
				<p className="text-sm text-text-secondary">
					Unverified. Used for your cursor, your face, and your name against decisions.
				</p>
				<button
					className="btn btn-md btn-primary"
					disabled={!valid}
					type="submit"
				>
					Join
				</button>
			</form>
		</div>
	);
}

const TONE: Record<Status, string> = {
	connecting: "text-text-tertiary",
	connected: "text-text-tertiary",
	reconnecting: "text-warning-ink",
	denied: "text-destructive-ink",
	closed: "text-text-tertiary",
};

function PaneToggle(
	{ onToggle, open, pane }: { onToggle: () => void; open: boolean; pane: Pane },
) {
	let label = pane === "chat" ? "conversation" : "decisions";
	let divider = pane === "chat" ? "M8 3.5v13" : "M12 3.5v13";

	return (
		<button
			aria-controls={paneId(pane)}
			aria-expanded={open}
			aria-label={`${open ? "Hide" : "Show"} ${label} pane`}
			className="btn btn-icon btn-ghost shrink-0"
			onClick={onToggle}
			type="button"
		>
			<svg aria-hidden="true" fill="none" height="18" viewBox="0 0 20 20" width="18">
				<rect height="13" rx="2" stroke="currentColor" width="15" x="2.5" y="3.5" />
				<path d={divider} stroke="currentColor" />
			</svg>
		</button>
	);
}

function Header(
	{
		chatOpen,
		decisionsOpen,
		handle,
		members,
		onToggleChat,
		onToggleDecisions,
		reason,
		room,
		status,
	}: {
		chatOpen: boolean;
		decisionsOpen: boolean;
		handle: string;
		members: Session.Member[];
		onToggleChat: () => void;
		onToggleDecisions: () => void;
		reason?: string;
		room: string;
		status: Status;
	},
) {
	// Presence over the prose already shows who is editing; this is the room
	// roster, which includes people who have it open but are not in the doc.
	let others = members.filter(member => member.handle !== handle);

	return (
		<header className="hairline-b flex h-12 shrink-0 items-center gap-3 px-4">
			<PaneToggle onToggle={onToggleChat} open={chatOpen} pane="chat" />
			<span className="text-sm font-semibold">chopin</span>
			<span className="text-sm text-text-tertiary">/r/{room}</span>
			<span className={`text-sm ${TONE[status]}`}>
				{status === "connected" ? reason : reason ?? status}
			</span>
			<div className="ml-auto flex min-w-0 items-center gap-2">
				{/* The tallest row a face sits in, so the only one drawn at 24px. */}
				<Face handle={handle} size={24} />
				<span className="truncate text-sm text-text-tertiary">
					@{handle}
					{others.length > 0 && ` · with ${others.map(member => `@${member.handle}`).join(", ")}`}
				</span>
			</div>
			<PaneToggle onToggle={onToggleDecisions} open={decisionsOpen} pane="decisions" />
		</header>
	);
}

function Room({ handle }: { handle: string }) {
	let [wire, setWire] = useState<Wire>();
	let [status, setStatus] = useState<Status>("connecting");
	let [reason, setReason] = useState<string>();
	let [members, setMembers] = useState<Session.Member[]>([]);
	let room = Identity.room();
	let user = useMemo(() => cursor(handle), [handle]);
	let [chatOpen, setChatOpen] = usePaneOpen("chat");
	let [decisionsOpen, setDecisionsOpen] = usePaneOpen("decisions");
	// Written from inside the editor, read by the decisions pane beside it.
	let [questions] = useState(() => new QuestionnaireStore());
	let [threads] = useState(() => new ThreadStore());
	let [reveal, setReveal] = useState<{ widget: string; token: number }>();
	let unanswered = useQuestionnaires(questions).filter(entry =>
		entry.value.questions.some(question => question.answer === undefined)
	);

	useEffect(() => {
		let socket = new Wire({
			room,
			handle,
			key: Identity.key(),
			onStatus: (next, why) => {
				setStatus(next);
				setReason(why);
			},
		});
		setWire(socket);

		let off = [
			socket.on<Session.Hello>("session:hello", frame => setMembers(frame.members)),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
			threads.listen(socket),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
			setWire(undefined);
		};
	}, [room, handle, threads]);

	return (
		<Workspace
			chat={
				<Chat
					connected={status === "connected"}
					handle={handle}
					onReveal={widget =>
						setReveal({ widget: widget || unanswered[0]?.id || "", token: Date.now() })}
					waiting={unanswered.length}
					wire={wire}
				/>
			}
			chatOpen={chatOpen}
			header={
				<Header
					chatOpen={chatOpen}
					decisionsOpen={decisionsOpen}
					handle={handle}
					members={members}
					onToggleChat={() => setChatOpen(value => !value)}
					onToggleDecisions={() => setDecisionsOpen(value => !value)}
					reason={reason}
					room={room}
					status={status}
				/>
			}
			decisionsOpen={decisionsOpen}
			decisions={
				<Decisions
					connected={status === "connected"}
					reveal={reveal}
					store={questions}
					threads={threads}
					wire={wire}
				/>
			}
			plan={
				<PlanEditor
					connection={status}
					questions={questions}
					threads={threads}
					user={user}
					wire={wire}
				/>
			}
		/>
	);
}

export function App() {
	let [handle, setHandle] = useState(Identity.handle);
	if (!handle) return <SignIn onDone={setHandle} />;
	return <Room handle={handle} />;
}
