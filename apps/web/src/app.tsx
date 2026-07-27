import { useEffect, useRef, useState } from "react";

import * as Identity from "./identity";
import { Wire } from "./wire";

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
					className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring"
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

function Face({ handle }: { handle: string }) {
	let [failed, setFailed] = useState(false);

	if (failed) {
		return (
			<span
				className="grid size-6 place-items-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground uppercase"
				title={handle}
			>
				{handle.slice(0, 2)}
			</span>
		);
	}

	return (
		<img
			alt={handle}
			className="size-6 rounded-full bg-muted"
			onError={() => setFailed(true)}
			referrerPolicy="no-referrer"
			src={`https://github.com/${encodeURIComponent(handle)}.png?size=48`}
			title={handle}
		/>
	);
}

const TONE: Record<Status, string> = {
	connecting: "text-muted-foreground",
	connected: "text-success",
	reconnecting: "text-warning",
	denied: "text-destructive",
	closed: "text-muted-foreground",
};

function Room({ handle }: { handle: string }) {
	let wire = useRef<Wire>(null);
	let [status, setStatus] = useState<Status>("connecting");
	let [reason, setReason] = useState<string>();
	let [members, setMembers] = useState<Session.Member[]>([]);
	let room = Identity.room();

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
		wire.current = socket;

		let off = [
			socket.on<Session.Hello>("session:hello", frame => setMembers(frame.members)),
			socket.on<Session.Presence>("session:presence", frame => setMembers(frame.members)),
		];

		return () => {
			for (let unsubscribe of off) unsubscribe();
			socket.dispose();
			wire.current = null;
		};
	}, [room, handle]);

	let others = members.filter(member => member.handle !== handle);

	return (
		<div className="flex h-full flex-col">
			<header className="flex items-center gap-3 border-b border-border px-4 py-2">
				<span className="text-sm font-semibold">chopin</span>
				<span className="text-sm text-muted-foreground">/r/{room}</span>
				<span className={`text-xs ${TONE[status]}`}>{reason ?? status}</span>
				<div className="ml-auto flex items-center gap-1">
					{members.map(member => <Face handle={member.handle} key={member.client} />)}
				</div>
			</header>

			<main className="grid flex-1 place-items-center text-sm text-muted-foreground">
				<div className="flex flex-col items-center gap-2">
					<p>
						You are <span className="text-foreground">@{handle}</span>
					</p>
					<p>
						{others.length === 0
							? "Nobody else is here."
							: `Also here: ${others.map(member => `@${member.handle}`).join(", ")}`}
					</p>
					<button
						className="mt-2 rounded-md border border-border px-3 py-1 text-xs hover:bg-muted"
						onClick={async () => {
							let started = performance.now();
							try {
								await wire.current?.ask("session:ping");
								setReason(`ping ${Math.round(performance.now() - started)}ms`);
							} catch (error) {
								setReason(error instanceof Error ? error.message : "ping failed");
							}
						}}
						type="button"
					>
						Ping
					</button>
				</div>
			</main>
		</div>
	);
}

export function App() {
	let [handle, setHandle] = useState(Identity.handle);
	if (!handle) return <SignIn onDone={setHandle} />;
	return <Room handle={handle} />;
}
