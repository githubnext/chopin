import { useEffect, useId, useRef } from "react";
import { CheckIcon, InfoIcon, LoaderIcon, SirenIcon, WarningIcon } from "@chopin/icons";

import {
	CONSENT_ACCEPT_LABEL,
	CONSENT_BODY,
	CONSENT_DECLINE_LABEL,
	CONSENT_TITLE,
	manualFallbackMessage,
	signInErrorMessage,
} from "./local-sign-in";
import { LocalLoginShell } from "./local-login-shell";

import type { ReactNode } from "react";
import type { LocalSignInState } from "./local-sign-in";

type Tone = "neutral" | "success" | "warning" | "danger";

/**
 * Renders one `LocalSignInState` with no side effects. `local-login.tsx`
 * owns the reducer, `Api.*` calls, the poll timer, and clipboard/tab access;
 * this component only presents whatever state it is given.
 */
export function LocalLoginView(
	{
		onCancel,
		onConsentDecision,
		onCopyAndOpen,
		onStart,
		state,
	}: {
		onCancel: () => void;
		onConsentDecision: (accept: boolean) => void;
		onCopyAndOpen: () => void;
		onStart: () => void;
		state: LocalSignInState;
	},
) {
	return (
		<LocalLoginShell>
			{state.status === "idle" && (
				<>
					<p className="mt-2 text-sm text-text-secondary">
						Sign in with GitHub to choose a repository and its planning channels.
					</p>
					<Actions>
						<PrimaryAction onClick={onStart}>Sign in with GitHub</PrimaryAction>
					</Actions>
				</>
			)}
			{state.status === "requesting" && (
				<StatusBanner
					icon={<LoaderIcon className="motion-safe:animate-spin" />}
					role="status"
					tone="neutral"
				>
					Waiting for device code...
				</StatusBanner>
			)}
			{state.status === "waiting" && (
				<>
					<StatusBanner
						icon={<span aria-hidden="true" className="sign-in-pulse" />}
						role="status"
						tone="neutral"
					>
						Waiting for authorization...
					</StatusBanner>
					<p className="sign-in-instruction mt-5">
						Enter one-time code: <strong>{state.userCode}</strong> at{" "}
						<a href={state.verificationUri} rel="noopener noreferrer" target="_blank">
							{state.verificationUri}
						</a>
					</p>
					{state.presentationFailure && (
						<StatusBanner role="alert" tone="warning">
							{manualFallbackMessage(
								state.presentationFailure,
								state.verificationUri,
								state.userCode,
							)}
						</StatusBanner>
					)}
					<Actions>
						<PrimaryAction onClick={onCopyAndOpen}>Copy code and open GitHub</PrimaryAction>
						<SecondaryAction onClick={onCancel}>Cancel</SecondaryAction>
					</Actions>
				</>
			)}
			{state.status === "consent" && (
				<LocalConsentStep onDecision={onConsentDecision} path={state.path} />
			)}
			{state.status === "complete" && (
				<StatusBanner role="status" tone="success">Signing in...</StatusBanner>
			)}
			{state.status === "cancelled" && (
				<>
					<StatusBanner role="status" tone="neutral">Sign-in was cancelled.</StatusBanner>
					<Actions>
						<PrimaryAction onClick={onStart}>Sign in with GitHub</PrimaryAction>
					</Actions>
				</>
			)}
			{state.status === "error" && (
				<>
					<StatusBanner role="alert" tone="danger">
						{signInErrorMessage(state.message)}
					</StatusBanner>
					<Actions>
						<PrimaryAction onClick={onStart}>Retry</PrimaryAction>
						<SecondaryAction onClick={onCancel}>Cancel</SecondaryAction>
					</Actions>
				</>
			)}
		</LocalLoginShell>
	);
}

const TONE_ICONS = {
	neutral: InfoIcon,
	success: CheckIcon,
	warning: WarningIcon,
	danger: SirenIcon,
} satisfies Record<Tone, unknown>;

/**
 * One sign-in state, colored by its semantic tone the same way document
 * callouts are: neutral for progress and cancellation, warning for anything
 * the user must act on, danger for failure, success for completion.
 */
function StatusBanner(
	{ children, icon, role, title, titleId, tone }: {
		children: ReactNode;
		icon?: ReactNode;
		role?: "alert" | "status";
		title?: string;
		titleId?: string;
		tone: Tone;
	},
) {
	let Icon = TONE_ICONS[tone];
	return (
		<div className="sign-in-banner" data-tone={tone} role={role}>
			<span className="sign-in-banner-icon">{icon ?? <Icon />}</span>
			<div className="min-w-0 flex-1">
				{title && <h3 className="sign-in-banner-title" id={titleId}>{title}</h3>}
				<div className={title ? "mt-1.5" : undefined}>{children}</div>
			</div>
		</div>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return <div className="mt-5 grid gap-2">{children}</div>;
}

function PrimaryAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
	return (
		<button className="btn btn-md btn-primary w-full" onClick={onClick} type="button">
			{children}
		</button>
	);
}

function SecondaryAction(
	{ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void },
) {
	return (
		<button
			className={`btn btn-md btn-secondary w-full${danger ? " sign-in-danger" : ""}`}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/**
 * The plaintext-storage consent step, shown in place inside the sign-in card
 * rather than over the page. It takes focus on its safe choice; Escape and
 * "No, cancel sign-in" both decline, and nothing else continues sign-in.
 */
function LocalConsentStep(
	{ path, onDecision }: { path: string; onDecision: (accept: boolean) => void },
) {
	let titleId = useId();
	let bodyId = useId();
	let actions = useRef<HTMLDivElement>(null);

	useEffect(() => {
		actions.current?.querySelector("button")?.focus();
	}, []);

	return (
		<section
			aria-describedby={bodyId}
			aria-labelledby={titleId}
			onKeyDown={event => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				onDecision(false);
			}}
		>
			<StatusBanner title={CONSENT_TITLE} titleId={titleId} tone="warning">
				<div className="space-y-2" id={bodyId}>
					<p>{CONSENT_BODY[0]}</p>
					<p>{CONSENT_BODY[1]}</p>
					<p className="sign-in-path">{path}</p>
					<p className="pt-1 font-semibold">{CONSENT_BODY[2]}</p>
				</div>
			</StatusBanner>
			<div ref={actions}>
				<Actions>
					<SecondaryAction onClick={() => onDecision(false)}>
						{CONSENT_DECLINE_LABEL}
					</SecondaryAction>
					<SecondaryAction danger onClick={() => onDecision(true)}>
						{CONSENT_ACCEPT_LABEL}
					</SecondaryAction>
				</Actions>
			</div>
		</section>
	);
}
