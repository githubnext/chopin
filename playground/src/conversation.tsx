import { CopilotAvatar } from "@github-ui/copilot-avatar";
import { Avatar, Button, Spinner, Textarea } from "@primer/react";
import { useEffect, useRef } from "react";
import { cue } from "./director";
import { avatarUrl, displayName } from "./plans";
import styles from "./plans.module.css";
import { Rich } from "./rich";
import { type PlanStore, usePlanState } from "./store";

export function Face({ login, size = 24 }: { login: string; size?: number }) {
	if (login === "copilot") return <CopilotAvatar size={size > 20 ? "medium" : "small"} />;
	return <Avatar src={avatarUrl(login)} size={size} alt={login} />;
}

export function Conversation({ store }: { store: PlanStore }) {
	let state = usePlanState(store);
	let list = useRef<HTMLOListElement>(null);
	let copilotWorking = state.activity?.login === "copilot";

	useEffect(() => {
		let element = list.current;
		if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [state.messages.length, copilotWorking]);

	let submit = () => {
		let text = state.composer.trim();
		if (!text && cue("ask")) return;
		if (!text) return;
		store.set(current => ({
			composer: "",
			messages: [
				...current.messages,
				{ id: `local-${current.messages.length}`, author: "monalisa", body: text, at: "just now" },
			],
		}));
	};

	return (
		<section className={styles.conversation} aria-labelledby="plan-conversation">
			<h2 id="plan-conversation" className={styles.panelHeading}>
				Conversation
			</h2>
			<ol ref={list} className={styles.messages}>
				{state.messages.map(message => (
					<li key={message.id} className={styles.message}>
						<Face login={message.author} />
						<div className={styles.messageBody}>
							<div className={styles.messageMeta}>
								<strong>{displayName(message.author)}</strong>
								<span>{message.at}</span>
							</div>
							<p>
								<Rich text={message.body} />
							</p>
						</div>
					</li>
				))}
				{copilotWorking && (
					<li className={styles.working}>
						<Spinner size="small" />
						<span>{state.activity?.text ?? "Copilot is working"}…</span>
					</li>
				)}
			</ol>
			<form
				className={styles.composer}
				onSubmit={event => {
					event.preventDefault();
					submit();
				}}
			>
				<Textarea
					aria-label="Comment"
					placeholder="Comment, or mention @copilot to change the plan"
					value={state.composer}
					onChange={event => store.set({ composer: event.target.value })}
					rows={3}
					resize="none"
					block
				/>
				<div className={styles.composerActions}>
					<Button type="submit" variant="primary" size="small">
						Comment
					</Button>
				</div>
			</form>
		</section>
	);
}
