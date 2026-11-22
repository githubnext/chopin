import {
	AnthropicIcon,
	CheckIcon,
	CircleCloseIcon,
	EllipsisIcon,
	ExternalLinkIcon,
	GitHubIcon,
	InfoIcon,
	LoaderIcon,
	OpenAIIcon,
	WarningIcon,
} from "@chopin/icons";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { Badge } from "@chopin/visuals";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { documentMenuKeyAction } from "../document-actions-menu";
import { useMenuDismissal } from "../menu-dismissal";
import { MenuItem } from "../menu-item";
import { motionImmediately } from "../motion-input";
import { TerminalAlert } from "../terminal-alert";
import { GET_COPILOT_URL } from "./accounts";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { KeyboardEvent } from "react";
import type { AccountAction, AccountBadge, AccountRow } from "./accounts";

const PROVIDER_MARKS = {
	"github-copilot": GitHubIcon,
	openai: OpenAIIcon,
	chatgpt: OpenAIIcon,
	anthropic: AnthropicIcon,
	claude: AnthropicIcon,
} as const satisfies Record<AiProvider, unknown>;

const BADGE_ICONS = {
	Connected: CheckIcon,
	"No Copilot access": CircleCloseIcon,
	"Checking…": LoaderIcon,
	"Not checked": InfoIcon,
	"Needs reconnecting": WarningIcon,
} as const satisfies Record<AccountBadge["label"], unknown>;

const ACTION_LABELS: Record<AccountAction, string> = {
	"add-key": "Add key",
	replace: "Replace",
	remove: "Remove",
	"use-token": "Use a token instead",
	"use-sign-in": "Use GitHub sign-in",
	"sign-in": "Sign in",
	disconnect: "Disconnect",
};

const DESTRUCTIVE = new Set<AccountAction>(["remove", "disconnect"]);

function actionLabel(row: AccountRow, action: AccountAction): string {
	if (action === "sign-in" && row.badge?.label === "Needs reconnecting") return "Sign in again";
	return ACTION_LABELS[action];
}

function actionName(row: AccountRow, action: AccountAction): string | undefined {
	let secret = row.provider === "github-copilot" ? "token" : "key";
	if (action === "add-key") return `Add key for ${row.name}`;
	if (action === "sign-in") return `${actionLabel(row, action)} to ${row.name}`;
	if (action === "replace") return `Replace ${row.name} ${secret}`;
	return undefined;
}

export type PendingAction = { provider: AccountRow["provider"]; action: AccountAction };

export type RowProblem = { provider: AccountRow["provider"]; message: string };

/**
 * A row's menu of what it offers besides the action its state asks for, in the Machines page's
 * recipe: it sits on the page below its button, Up or Down on the button opens it, the arrows,
 * Home and End move within it, and Escape closes it and returns to the button. A choice that opens
 * a dialog first returns focus to the button, so the dialog gives it back there.
 */
function AccountMenu(
	{ disabled, onAction, row }: {
		disabled: boolean;
		onAction: (row: AccountRow, action: AccountAction) => void;
		row: AccountRow;
	},
) {
	let id = useId();
	let trigger = useRef<HTMLButtonElement>(null);
	let menu = useRef<HTMLDivElement>(null);
	let [open, setOpen] = useState(false);
	let initialItem = useRef<"first" | "last">("first");
	let presence = useTransitionPresence(open ? true : undefined, 150, motionImmediately());
	let mounted = presence.phase !== "closed";
	let name = `More actions for ${row.name}`;
	let close = (restoreFocus: boolean) => {
		setOpen(false);
		if (restoreFocus) trigger.current?.focus();
	};
	let openAt = (item: "first" | "last") => {
		initialItem.current = item;
		setOpen(true);
	};
	useMenuDismissal(open, [trigger, menu], close);
	useLayoutEffect(() => {
		if (!mounted) return;
		let place = () => {
			let anchor = trigger.current?.getBoundingClientRect();
			if (!anchor || !menu.current) return;
			menu.current.style.top = `${anchor.bottom + 4}px`;
			menu.current.style.right = `${document.documentElement.clientWidth - anchor.right}px`;
		};
		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [mounted]);
	useEffect(() => {
		if (!open) return;
		let items = menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]");
		items?.[initialItem.current === "last" ? items.length - 1 : 0]?.focus();
	}, [open]);
	let menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Tab") {
			close(false);
			return;
		}
		let action = documentMenuKeyAction(event.key);
		if (!action) return;
		event.preventDefault();
		if (action === "close") {
			close(true);
			return;
		}
		let items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
		let current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
		let next = action === "first"
			? 0
			: action === "last"
			? items.length - 1
			: action === "next"
			? (current + 1) % items.length
			: (current - 1 + items.length) % items.length;
		items[next]?.focus();
	};
	return (
		<>
			<button
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={name}
				className="btn btn-icon btn-ghost ai-account-more"
				data-tooltip="More actions"
				disabled={disabled}
				onClick={() => open ? close(false) : openAt("first")}
				onKeyDown={event => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					openAt(event.key === "ArrowUp" ? "last" : "first");
				}}
				ref={trigger}
				type="button"
			>
				<EllipsisIcon aria-hidden="true" />
			</button>
			{mounted && createPortal(
				<div
					aria-hidden={presence.phase === "closing" ? "true" : undefined}
					aria-label={name}
					className={`ai-account-menu motion-dropdown ${presence.className}`}
					id={id}
					inert={presence.phase === "closing"}
					onKeyDown={menuKeyDown}
					ref={menu}
					role="menu"
				>
					{row.more.map(action => (
						<MenuItem
							key={action}
							onClick={() => {
								close(true);
								onAction(row, action);
							}}
							tone={DESTRUCTIVE.has(action) ? "destructive" : "normal"}
						>
							{actionLabel(row, action)}
						</MenuItem>
					))}
				</div>,
				document.body,
			)}
		</>
	);
}

/**
 * One account: its mark, name and lines, then four fixed columns, so no row's controls move with
 * what its neighbours hold: its state, the action that state asks for (or Get Copilot), and its
 * menu, whose glyph ends on the card's content edge.
 */
export function AccountRowView(
	{ busy, onAction, problem, row }: {
		busy?: PendingAction;
		onAction: (row: AccountRow, action: AccountAction) => void;
		problem?: string;
		row: AccountRow;
	},
) {
	let Mark = PROVIDER_MARKS[row.provider];
	return (
		<li className="ai-account" data-provider={row.provider}>
			<span aria-hidden="true" className="ai-account-mark">
				<Mark size={18} />
			</span>
			<div className="ai-account-text">
				<h3 className="ai-account-name">{row.name}</h3>
				{row.lines.map(line => <p className="ai-account-line" key={line}>{line}</p>)}
				{problem && <TerminalAlert className="ai-account-problem">{problem}</TerminalAlert>}
			</div>
			<div className="ai-account-status">
				{row.badge
					? (
						<Badge
							data-checking={row.badge.label === "Checking…" || undefined}
							icon={BADGE_ICONS[row.badge.label]}
							label={row.badge.label}
							size="sm"
							tone={row.badge.tone}
						/>
					)
					: <span className="ai-account-unconnected">Not connected</span>}
			</div>
			<div className="ai-account-action">
				{row.getCopilot && (
					<a
						className="btn btn-sm btn-outline"
						href={GET_COPILOT_URL}
						rel="noreferrer"
						target="_blank"
					>
						Get Copilot
						<ExternalLinkIcon aria-hidden="true" />
					</a>
				)}
				{row.action && (
					<button
						aria-label={actionName(row, row.action)}
						className="btn btn-sm btn-outline"
						disabled={!!busy}
						onClick={() => onAction(row, row.action!)}
						type="button"
					>
						{actionLabel(row, row.action)}
					</button>
				)}
			</div>
			<div className="ai-account-menu-slot">
				{row.more.length > 0 && <AccountMenu disabled={!!busy} onAction={onAction} row={row} />}
			</div>
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
