import { SparkleIcon } from "@chopin/icons";

import { SPEAKER_TAGS } from "./speakers";
import "./speaker.css";

import type { ReactNode } from "react";
import type { Speaker, SpeakerKind } from "./speakers";

/** The small tag beside an app's name, as Slack's `APP`: what kind of speaker it is. */
export function SpeakerTag({ kind }: { kind: Exclude<SpeakerKind, "user"> }) {
	return <span className="chat-speaker-tag" data-speaker-tag={kind}>{SPEAKER_TAGS[kind]}</span>;
}

/** A research child's avatar: a 36px rounded square, as Slack draws an app's. */
export function ResearchAvatar() {
	return (
		<span className="chat-app-avatar" data-app-avatar="research">
			<SparkleIcon aria-hidden="true" size={18} />
		</span>
	);
}

/** The name line of a row: the name in bold, the kind's tag, and the time beside them. */
export function SpeakerHead({ speaker }: { speaker: Speaker }) {
	return (
		<div className="flex items-baseline gap-2 text-base" data-chat-head="">
			<span className="min-w-0 break-all font-bold" data-speaker-name="">{speaker.name}</span>
			{speaker.kind !== "user" && <SpeakerTag kind={speaker.kind} />}
			{speaker.time !== undefined && (
				<span className="text-xs text-text-tertiary tabular-nums">{speaker.time}</span>
			)}
		</div>
	);
}

/**
 * A row an app speaks outside a message group, laid out as a Slack message: its avatar in the
 * 36px gutter, its name line, and what it says under it. It has no toolbar of its own.
 */
export function AppRow(
	{ avatar, children, enter = false, speaker }: {
		avatar: ReactNode;
		children: ReactNode;
		enter?: boolean;
		speaker: Speaker;
	},
) {
	return (
		<div
			className="flex gap-2"
			data-chat-enter={enter || undefined}
			data-chat-system=""
			data-speaker-kind={speaker.kind}
		>
			<div aria-hidden="true" className="w-9 shrink-0" data-chat-avatar="">{avatar}</div>
			<div className="-mt-0.5 flex min-w-0 flex-1 flex-col gap-1">
				<SpeakerHead speaker={speaker} />
				<div className="min-w-0">{children}</div>
			</div>
		</div>
	);
}

/**
 * What an app attaches to its message, as Slack draws an app message's attachment: a rounded bar
 * down its start edge and the content beside it. `active` tints the bar while work is under way.
 */
export function AppAttachment(
	{ active = false, children, label }: { active?: boolean; children: ReactNode; label?: string },
) {
	return (
		<div
			aria-label={label}
			className="chat-app-attachment"
			data-active={active ? "" : undefined}
			role={label ? "group" : undefined}
		>
			{children}
		</div>
	);
}
