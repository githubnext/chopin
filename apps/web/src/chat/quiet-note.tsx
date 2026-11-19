import { Suspense, useEffect } from "react";
import type { MouseEvent } from "react";
import { LockIcon } from "@chopin/icons";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";

import { LazyFixSteps, loadFixSteps } from "../fix-steps-lazy";
import { AgentAvatar } from "./presence";
import { AppRow } from "./speaker";
import { messageSpeaker } from "./speakers";

import type { MachineFix } from "../machine-fix";

import "./quiet-note.css";

/**
 * What chopin says to one person when a message to it could not be taken: Slack's ephemeral
 * message, under a quiet "Only visible to you", in the transcript at the time it was said: what is
 * said after it comes after it, as Slack's does (`chronology.ts`). chopin's own row
 * says it in one sentence (the server's words), and where there is something to fix, How to fix
 * unfolds the same fix-it steps as the machine button's menu; where the person has a page of their
 * own to fix it on, a link to it does. Nothing is kept for later, so the
 * words are back in the draft; the row stays until chopin takes a message, or a later refusal
 * takes its place.
 */
export function QuietNote(
	{ text, ts, fix, link, onChoose, onNavigate }: {
		text: string;
		/** When it was said, in seconds, as a message's time is. */
		ts?: number;
		fix?: MachineFix;
		/** A page of Chopin's own where the person can fix it, followed in place. */
		link?: { label: string; href: string };
		onChoose?: () => void;
		onNavigate?: (href: string) => void;
	},
) {
	let steps = useUnfold();
	useEffect(() => {
		if (fix) void loadFixSteps();
	}, [!!fix]);
	return (
		<div className="quiet-note" data-quiet-note="" role="status">
			<p className="quiet-note-label">
				<LockIcon aria-hidden="true" size={12} />
				Only visible to you
			</p>
			<AppRow
				avatar={<AgentAvatar />}
				speaker={messageSpeaker({ author: { kind: "agent" }, ...(ts === undefined ? {} : { ts }) })}
			>
				<p className="quiet-note-text">
					{text}
					{link && (
						<>
							{" "}
							<a
								className="quiet-note-fix"
								href={link.href}
								onClick={event => {
									if (!onNavigate || !plainClick(event)) return;
									event.preventDefault();
									onNavigate(link.href);
								}}
							>
								{link.label}
							</a>
						</>
					)}
					{fix && (
						<>
							{" "}
							<UnfoldToggle className="quiet-note-fix" unfold={steps}>How to fix</UnfoldToggle>
						</>
					)}
				</p>
				{fix && (
					<UnfoldPanel unfold={steps}>
						<div className="quiet-note-steps">
							<Suspense fallback={null}>
								<LazyFixSteps
									fix={fix}
									onChoose={onChoose}
									onNavigate={onNavigate}
									titled={false}
								/>
							</Suspense>
						</div>
					</UnfoldPanel>
				)}
			</AppRow>
		</div>
	);
}

/** A click that follows a link in place: the main button, with no key asking for another tab. */
function plainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey
		&& !event.altKey;
}
