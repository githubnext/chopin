import { CloseIcon } from "@chopin/icons";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { useId, useRef, useState } from "react";

import { IconButton } from "../icon-button";
import { motionImmediately } from "../motion-input";
import { NavigationDialog } from "../navigation-dialog";
import { TerminalAlert } from "../terminal-alert";
import { AiAccountsError, connectCredential, PROVIDER_NAMES, removeCredential } from "./accounts";

import type { AiCredentialSummary, AiProvider } from "@chopin/protocol/ai-credentials";
import type { NavigationDialogMotion } from "../navigation-dialog";

export type KeyRequest = { provider: AiProvider; replacing: boolean; opened: number };

function failure(error: unknown): string {
	return error instanceof AiAccountsError
		? error.message
		: "Something went wrong. Try again in a moment.";
}

function keyWords({ provider, replacing }: KeyRequest) {
	let name = PROVIDER_NAMES[provider];
	if (provider === "github-copilot") {
		return {
			title: replacing ? "Replace GitHub Copilot token" : "Use a GitHub token for Copilot",
			lead:
				"Copilot runs through this token's GitHub account instead of your sign-in. Machines get a stand-in, never the token.",
			label: "GitHub token",
			submit: replacing ? "Replace token" : "Use token",
		};
	}
	return {
		title: replacing ? `Replace ${name} key` : `Add ${name} key`,
		lead: `Chopin checks it with ${name} before saving it. Machines get a stand-in, never the key.`,
		label: "API key",
		submit: replacing ? "Replace key" : "Add key",
	};
}

export function KeyDialog(
	{ motion, onDismiss, onSaved, request }: {
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onSaved: (summary: AiCredentialSummary) => void;
		request: KeyRequest;
	},
) {
	let field = useRef<HTMLInputElement>(null);
	let fieldId = useId();
	let errorId = useId();
	let [secret, setSecret] = useState("");
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let words = keyWords(request);
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function save() {
		if (busy || !secret.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			onSaved(
				await connectCredential(request.provider, { kind: "api-key", secret: secret.trim() }),
			);
		} catch (err) {
			setError(failure(err));
			setBusy(false);
			requestAnimationFrame(() => field.current?.focus());
		}
	}
	return (
		<NavigationDialog
			className="ai-accounts-dialog"
			initialFocus={field}
			motion={motion}
			onDismiss={dismiss}
			title={words.title}
		>
			<span className="ai-accounts-dialog-close">
				<IconButton aria-label="Close" data-tooltip="Close" onClick={dismiss}>
					<CloseIcon aria-hidden="true" />
				</IconButton>
			</span>
			<form
				className="ai-accounts-dialog-body"
				onSubmit={event => {
					event.preventDefault();
					void save();
				}}
			>
				<p className="ai-accounts-dialog-lead">{words.lead}</p>
				<div className="ai-accounts-field">
					<label className="font-medium text-text-primary" htmlFor={fieldId}>{words.label}</label>
					<input
						aria-describedby={error ? errorId : undefined}
						aria-invalid={error ? true : undefined}
						autoCapitalize="off"
						autoComplete="off"
						autoCorrect="off"
						className="field h-8 w-full px-2 text-sm"
						id={fieldId}
						onChange={event => {
							setSecret(event.currentTarget.value);
							if (error) setError(undefined);
						}}
						readOnly={busy}
						ref={field}
						spellCheck={false}
						type="password"
						value={secret}
					/>
					{error && (
						<TerminalAlert className="text-sm text-destructive-ink">
							<span id={errorId}>{error}</span>
						</TerminalAlert>
					)}
				</div>
				<div className="ai-accounts-dialog-actions">
					<button
						className="btn btn-md btn-secondary"
						disabled={busy}
						onClick={dismiss}
						type="button"
					>
						Cancel
					</button>
					<button
						className="btn btn-md btn-primary"
						disabled={busy || !secret.trim()}
						type="submit"
					>
						{busy ? "Checking…" : words.submit}
					</button>
				</div>
			</form>
		</NavigationDialog>
	);
}

export function RemoveKeyDialog(
	{ motion, onDismiss, onRemoved, provider }: {
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onRemoved: () => void;
		provider: AiProvider;
	},
) {
	let cancel = useRef<HTMLButtonElement>(null);
	let [busy, setBusy] = useState(false);
	let [error, setError] = useState<string>();
	let name = PROVIDER_NAMES[provider];
	let dismiss = () => {
		if (!busy) onDismiss();
	};
	async function remove() {
		if (busy) return;
		setBusy(true);
		setError(undefined);
		try {
			await removeCredential(provider);
			onRemoved();
		} catch (err) {
			setError(failure(err));
			setBusy(false);
		}
	}
	return (
		<NavigationDialog
			initialFocus={cancel}
			motion={motion}
			onDismiss={dismiss}
			title={`Remove ${name} key?`}
		>
			<p className="ai-accounts-dialog-lead mt-2">
				chopin stops using this key on every machine. You can add a key again at any time.
			</p>
			{error && <TerminalAlert className="mt-3 text-sm text-destructive-ink">{error}
			</TerminalAlert>}
			<div className="ai-accounts-dialog-actions mt-4">
				<button
					className="btn btn-md btn-secondary"
					disabled={busy}
					onClick={dismiss}
					ref={cancel}
					type="button"
				>
					Cancel
				</button>
				<button
					className="btn btn-md btn-destructive"
					disabled={busy}
					onClick={() => void remove()}
					type="button"
				>
					{busy ? "Removing…" : "Remove key"}
				</button>
			</div>
		</NavigationDialog>
	);
}

export function useDialog<T>(value: T | undefined) {
	return useTransitionPresence(value, 150, motionImmediately());
}
