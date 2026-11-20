import { RestartIcon } from "@chopin/icons";
import { InlineNotice } from "@chopin/visuals/inline-notice";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
	accountRows,
	AiAccountsError,
	checkCopilot,
	listCredentials,
	PROVIDER_NAMES,
	removeCredential,
	withCheck,
	withCredential,
	withoutCredential,
} from "./accounts";
import { KeyDialog, RemoveKeyDialog, useDialog } from "./dialogs";
import { AccountSection } from "./rows";

import type { AiCredentialSummary, AiProvider } from "@chopin/protocol/ai-credentials";
import type { AccountAction, AccountRow } from "./accounts";
import type { KeyRequest } from "./dialogs";
import type { PendingAction, RowProblem } from "./rows";

import "./ai-accounts.css";

/**
 * The person's AI credentials, and the check of their GitHub Copilot that the page runs once each
 * time it opens, as soon as the list is in. The list's answer stands until the check's arrives; a
 * check that couldn't finish leaves Copilot's access unknown.
 */
function useCredentials() {
	let [credentials, setCredentials] = useState<AiCredentialSummary[]>();
	let [problem, setProblem] = useState<string>();
	let [checking, setChecking] = useState(true);
	let request = useRef<AbortController>(undefined);
	let check = useRef<AbortController>(undefined);
	let checkOnOpen = useCallback(async (listed: AiCredentialSummary[]) => {
		let checked = new AbortController();
		check.current = checked;
		let copilot = listed.find(credential => credential.provider === "github-copilot");
		let answer = await checkCopilot(checked.signal).catch(() =>
			copilot && { ...copilot, copilotAccess: "unknown" as const }
		);
		if (checked.signal.aborted) return;
		setChecking(false);
		if (answer) setCredentials(current => current && withCheck(current, answer));
	}, []);
	let load = useCallback(async () => {
		request.current?.abort();
		let controller = new AbortController();
		request.current = controller;
		setProblem(undefined);
		try {
			let listed = await listCredentials(controller.signal);
			if (controller.signal.aborted) return;
			setCredentials(listed);
			if (!check.current) void checkOnOpen(listed);
		} catch (error) {
			if (controller.signal.aborted) return;
			setProblem(
				error instanceof AiAccountsError
					? error.message
					: "Something went wrong. Try again in a moment.",
			);
		}
	}, [checkOnOpen]);
	useEffect(() => {
		void load();
		return () => {
			request.current?.abort();
			check.current?.abort();
			check.current = undefined;
		};
	}, [load]);
	return { credentials, setCredentials, problem, load, checking };
}

function focusLost() {
	let active = document.activeElement;
	return !active || active === document.body || !!active.closest("[inert]");
}

export function AiAccountsView(
	{ checking, credentials, now, onAction, pending, problem }: {
		checking: boolean;
		credentials: readonly AiCredentialSummary[];
		now: number;
		onAction: (row: AccountRow, action: AccountAction) => void;
		pending?: PendingAction;
		problem?: RowProblem;
	},
) {
	let { keys, signIns } = accountRows(credentials, now, checking);
	let shared = { busy: pending, onAction, problem };
	return (
		<>
			<AccountSection {...shared} rows={signIns} title="Sign-ins" />
			<AccountSection {...shared} rows={keys} title="API keys" />
		</>
	);
}

export default function AiAccountsPage() {
	let heading = useRef<HTMLHeadingElement>(null);
	let main = useRef<HTMLElement>(null);
	let [returnTo, setReturnTo] = useState<AiProvider>();
	let { credentials, setCredentials, problem, load, checking } = useCredentials();
	let [keyRequest, setKeyRequest] = useState<KeyRequest>();
	let [removing, setRemoving] = useState<{ provider: AiProvider; opened: number }>();
	let opened = useRef(0);
	let [pending, setPending] = useState<PendingAction>();
	let [rowProblem, setRowProblem] = useState<RowProblem>();
	let [announcement, setAnnouncement] = useState("");
	let keyDialog = useDialog(keyRequest);
	let removeDialog = useDialog(removing);
	let dialogShown = [keyDialog.phase, removeDialog.phase].some(phase =>
		phase === "opening" || phase === "open"
	);
	useLayoutEffect(() => {
		if (!document.activeElement?.closest('[role="dialog"]')) {
			heading.current?.focus({ preventScroll: true });
		}
	}, []);
	useLayoutEffect(() => {
		if (!returnTo || dialogShown) return;
		setReturnTo(undefined);
		if (!focusLost()) return;
		let row = main.current?.querySelector(`[data-provider="${returnTo}"]`);
		(row?.querySelector<HTMLElement>("button:enabled") ?? heading.current)?.focus();
	}, [returnTo, dialogShown]);
	let changed = (summary: AiCredentialSummary) =>
		setCredentials(current => withCredential(current ?? [], summary));
	async function run(row: AccountRow, action: AccountAction, work: () => Promise<void>) {
		setPending({ provider: row.provider, action });
		setRowProblem(undefined);
		try {
			await work();
		} catch (error) {
			setRowProblem({
				provider: row.provider,
				message: error instanceof AiAccountsError
					? error.message
					: "Something went wrong. Try again in a moment.",
			});
		} finally {
			setPending(undefined);
			setReturnTo(row.provider);
		}
	}
	let act = (row: AccountRow, action: AccountAction) => {
		switch (action) {
			case "add-key":
			case "use-token":
				setKeyRequest({ provider: row.provider, replacing: false, opened: ++opened.current });
				return;
			case "replace":
				setKeyRequest({ provider: row.provider, replacing: true, opened: ++opened.current });
				return;
			case "remove":
				setRemoving({ provider: row.provider, opened: ++opened.current });
				return;
			case "use-sign-in":
				void run(row, action, async () => {
					await removeCredential(row.provider);
					setCredentials(current => withoutCredential(current ?? [], row.provider));
					setAnnouncement("GitHub Copilot uses your GitHub sign-in");
					await load();
				});
		}
	};
	return (
		<div className="ai-accounts-page" data-hosted="">
			<main className="ai-accounts-main" ref={main}>
				<div className="ai-accounts-heading">
					<h1 className="text-xl font-semibold" ref={heading} tabIndex={-1}>AI accounts</h1>
					<p className="ai-accounts-description text-sm text-text-secondary">
						chopin uses these to work for you on any machine. Machines get a stand-in, never the key
						itself.
					</p>
				</div>
				<p className="sr-only" role="status">{announcement}</p>
				{credentials
					? (
						<AiAccountsView
							checking={checking}
							credentials={credentials}
							now={Date.now()}
							onAction={act}
							pending={pending}
							problem={rowProblem}
						/>
					)
					: problem
					? (
						<InlineNotice
							actions={
								<button
									className="btn btn-xs btn-outline"
									onClick={() => void load()}
									type="button"
								>
									<RestartIcon aria-hidden="true" />
									Retry
								</button>
							}
							message={problem}
							title="Couldn't load your AI accounts"
						/>
					)
					: <p className="ai-accounts-loading" role="status">Loading your AI accounts…</p>}
			</main>
			{keyDialog.phase !== "closed" && (
				<KeyDialog
					key={keyDialog.value.opened}
					motion={keyDialog}
					onDismiss={() => setKeyRequest(undefined)}
					onSaved={summary => {
						changed(summary);
						setKeyRequest(undefined);
						setReturnTo(summary.provider);
						setAnnouncement(`${PROVIDER_NAMES[summary.provider]} connected`);
					}}
					request={keyDialog.value}
				/>
			)}
			{removeDialog.phase !== "closed" && (
				<RemoveKeyDialog
					key={removeDialog.value.opened}
					motion={removeDialog}
					onDismiss={() => setRemoving(undefined)}
					onRemoved={() => {
						let { provider } = removeDialog.value;
						setCredentials(current => withoutCredential(current ?? [], provider));
						setRemoving(undefined);
						setReturnTo(provider);
						setAnnouncement(`${PROVIDER_NAMES[provider]} key removed`);
					}}
					provider={removeDialog.value.provider}
				/>
			)}
		</div>
	);
}
