import { useEffect, useMemo, useState } from "react";
import {
	cursor,
	Decisions,
	PlanEditor,
	QuestionnaireStore,
	ThreadStore,
	useQuestionnaires,
} from "@chopin/editor";

import { Chat } from "./chat/chat";
import * as Identity from "./identity";
import { Wire } from "./wire";
import { Workspace } from "./workspace";

import type { Session } from "@chopin/protocol";
import type { Status } from "./wire";

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
					className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:border-ring"
					id="handle"
					onChange={event => setValue(event.target.value.trim())}
					placeholder="octocat"
					value={value}
				/>
				<p className="text-xs text-muted-foreground">
					Unverified. Used for your cursor, your face, and your name against decisions.
				</p>
				<button
					className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
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
	connecting: "text-muted-foreground",
	connected: "text-muted-foreground",
	reconnecting: "text-warning",
	denied: "text-destructive",
	closed: "text-muted-foreground",
};

function Header(
	{ handle, members, reason, room, status }: {
		handle: string;
		members: Session.Member[];
		reason?: string;
		room: string;
		status: Status;
	},
) {
	// Presence over the prose already shows who is editing; this is the room
	// roster, which includes people who have it open but are not in the doc.
	let others = members.filter(member => member.handle !== handle);

	return (
		<header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
			<span className="text-sm font-semibold">chopin</span>
			<span className="text-sm text-muted-foreground">/r/{room}</span>
			<span className={`text-xs ${TONE[status]}`}>
				{status === "connected" ? reason : reason ?? status}
			</span>
			<span className="ml-auto text-xs text-muted-foreground">
				@{handle}
				{others.length > 0 && ` · with ${others.map(member => `@${member.handle}`).join(", ")}`}
			</span>
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
			header={
				<Header
					handle={handle}
					members={members}
					reason={reason}
					room={room}
					status={status}
				/>
			}
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
