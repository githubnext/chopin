import { CopilotAvatar } from "@github-ui/copilot-avatar";
import { CheckIcon, ChevronRightIcon, FileCodeIcon } from "@primer/octicons-react";
import { Avatar, Button, Link, Spinner, Textarea } from "@primer/react";
import { useEffect, useRef } from "react";
import { cue } from "./director";
import { avatarUrl, demoRepo, displayName, presenter, type Source, sourceUrl } from "./plans";
import styles from "./plans.module.css";
import { Rich } from "./rich";
import { type PlanStore, usePlanState } from "./store";

export function Face({ login, size = 24 }: { login: string; size?: number }) {
	if (login === "copilot") return <CopilotAvatar size={size > 20 ? "medium" : "small"} />;
	return <Avatar src={avatarUrl(login)} size={size} alt={login} />;
}

function Sources({ sources }: { sources: Source[] }) {
	let files = new Set(sources.map(source => source.path)).size;
	return (
		<details className={styles.sources} open>
			<summary>
				<ChevronRightIcon className={styles.sourcesChevron} />
				Read {files} {files === 1 ? "file" : "files"} in {demoRepo}
			</summary>
			<ul>
				{sources.map(source => (
					<li key={sourceUrl(source)}>
						<FileCodeIcon className={styles.sourceIcon} />
						<Link href={sourceUrl(source)}>{source.path}</Link>
						{source.lines && (
							<span>
								{source.lines[1] > source.lines[0]
									? `lines ${source.lines[0]}–${source.lines[1]}`
									: `line ${source.lines[0]}`}
							</span>
						)}
					</li>
				))}
			</ul>
		</details>
	);
}

export function Conversation({ store }: { store: PlanStore }) {
	let state = usePlanState(store);
	let list = useRef<HTMLOListElement>(null);
	let copilotWorking = state.activity?.login === "copilot";
	let steps = copilotWorking ? state.activity?.steps : undefined;

	useEffect(() => {
		let element = list.current;
		if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
	}, [state.messages.length, copilotWorking, steps?.length]);

	let submit = () => {
		let text = state.composer.trim();
		if (!text && cue("comment")) return;
		if (!text) return;
		store.set(current => ({
			composer: "",
			messages: [
				...current.messages,
				{ id: `local-${current.messages.length}`, author: presenter, body: text, at: "just now" },
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
							{message.sources && <Sources sources={message.sources} />}
						</div>
					</li>
				))}
				{steps && (
					<li className={styles.message}>
						<Face login="copilot" />
						<div className={styles.messageBody}>
							<div className={styles.messageMeta}>
								<strong>Copilot</strong>
								<span>researching</span>
							</div>
							<ol className={styles.trace} aria-live="polite">
								{steps.map(step => (
									<li key={step}>
										<CheckIcon className={styles.traceDone} />
										{step}
									</li>
								))}
								<li>
									<Spinner size="small" className={styles.traceSpinner} />
									{state.activity?.text}…
								</li>
							</ol>
						</div>
					</li>
				)}
				{copilotWorking && !steps && (
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
