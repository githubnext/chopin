import {
	CheckIcon,
	CircleCloseIcon,
	GitHubIcon,
	InfoIcon,
	KeyIcon,
	WarningIcon,
} from "@chopin/icons";
import { Badge } from "@chopin/visuals";
import { useId } from "react";

import { TerminalAlert } from "../terminal-alert";
import { GET_COPILOT_URL } from "./accounts";

import type { AccountAction, AccountBadge, AccountRow } from "./accounts";

const BADGE_ICONS = {
	Connected: CheckIcon,
	"No Copilot access": CircleCloseIcon,
	"Not checked": InfoIcon,
	"Needs reconnecting": WarningIcon,
} as const satisfies Record<AccountBadge["label"], unknown>;

const ACTION_LABELS: Record<AccountAction, string> = {
	"add-key": "Add key",
	replace: "Replace",
	remove: "Remove",
	"use-token": "Use a token instead",
	"use-sign-in": "Use GitHub sign-in",
	"check-again": "Check again",
};

function actionName(row: AccountRow, action: AccountAction): string | undefined {
	let secret = row.provider === "github-copilot" ? "token" : "key";
	if (action === "add-key") return `Add key for ${row.name}`;
	if (action === "replace" || action === "remove") {
		return `${ACTION_LABELS[action]} ${row.name} ${secret}`;
	}
	return undefined;
}

export type PendingAction = { provider: AccountRow["provider"]; action: AccountAction };

export type RowProblem = { provider: AccountRow["provider"]; message: string };

export function AccountRowView(
	{ busy, onAction, problem, row }: {
		busy?: PendingAction;
		onAction: (row: AccountRow, action: AccountAction) => void;
		problem?: string;
		row: AccountRow;
	},
) {
	let checking = busy?.provider === row.provider && busy.action === "check-again";
	return (
		<li className="ai-account" data-provider={row.provider}>
			<span aria-hidden="true" className="ai-account-mark">
				{row.provider === "github-copilot" ? <GitHubIcon size={18} /> : <KeyIcon size={18} />}
			</span>
			<div className="ai-account-text">
				<h3 className="ai-account-name">{row.name}</h3>
				{row.lines.map(line => <p className="ai-account-line" key={line}>{line}</p>)}
				{row.getCopilot && (
					<a className="ai-account-link" href={GET_COPILOT_URL} rel="noreferrer" target="_blank">
						Get Copilot
					</a>
				)}
				{problem && <TerminalAlert className="ai-account-problem">{problem}</TerminalAlert>}
			</div>
			{(row.badge || row.actions.length > 0) && (
				<div className="ai-account-end">
					{row.badge && (
						<Badge
							icon={BADGE_ICONS[row.badge.label]}
							label={row.badge.label}
							size="sm"
							tone={row.badge.tone}
						/>
					)}
					{row.actions.length > 0 && (
						<div className="ai-account-actions">
							{row.actions.map(action => (
								<button
									aria-label={actionName(row, action)}
									className={`btn btn-md ${action === "add-key" ? "btn-primary" : "btn-secondary"}`}
									disabled={!!busy}
									key={action}
									onClick={() => onAction(row, action)}
									type="button"
								>
									{checking && action === "check-again" ? "Checking…" : ACTION_LABELS[action]}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</li>
	);
}

export function AccountSection(
	{ busy, onAction, problem, rows, title }: {
		busy?: PendingAction;
		onAction: (row: AccountRow, action: AccountAction) => void;
		problem?: RowProblem;
		rows: AccountRow[];
		title: string;
	},
) {
	let headingId = useId();
	return (
		<section aria-labelledby={headingId} className="ai-accounts-section">
			<h2 className="ai-accounts-section-title" id={headingId}>{title}</h2>
			<ul className="ai-accounts-list">
				{rows.map(row => (
					<AccountRowView
						busy={busy}
						key={row.provider}
						onAction={onAction}
						problem={problem?.provider === row.provider ? problem.message : undefined}
						row={row}
					/>
				))}
			</ul>
		</section>
	);
}
