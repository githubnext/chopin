import { accountRows } from "../../ai-accounts/accounts";
import { AccountRowView } from "../../ai-accounts/rows";
import { AuditPlate, StateLabel } from "../frame";

import type { AiCredentialSummary } from "@chopin/protocol/ai-credentials";
import type { AccountRow } from "../../ai-accounts/accounts";

import "../../ai-accounts/ai-accounts.css";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

const OPENAI: AiCredentialSummary = {
	provider: "openai",
	kind: "api-key",
	suffix: "7Qxa",
	lastUsedAt: "2026-11-19T11:58:00.000Z",
};

function copilot(
	copilotAccess: AiCredentialSummary["copilotAccess"],
	{ checking = false, token = false } = {},
): AccountRow {
	let summary: AiCredentialSummary = token
		? { provider: "github-copilot", kind: "api-key", suffix: "f00d", copilotAccess }
		: { provider: "github-copilot", kind: "github-sign-in", copilotAccess };
	return accountRows([summary], NOW, checking).signIns[0]!;
}

function key(summary?: AiCredentialSummary): AccountRow {
	return accountRows(summary ? [summary] : [], NOW).keys[0]!;
}

const SPECIMENS: { label: string; row: AccountRow; problem?: string }[] = [
	{ label: "Copilot through the sign-in", row: copilot("access") },
	{ label: "No Copilot access", row: copilot("none") },
	{ label: "Checking as the page opens", row: copilot(undefined, { checking: true }) },
	{ label: "Check unfinished", row: copilot("unknown") },
	{
		label: "Switching to the sign-in failed",
		row: copilot("access", { token: true }),
		problem: "Couldn't reach Chopin. Check your connection, then try again.",
	},
	{ label: "Key connected", row: key(OPENAI) },
	{ label: "Key unreadable", row: key({ ...OPENAI, unusable: true }) },
	{
		label: "Key refused by its provider",
		row: key({ ...OPENAI, rejectedAt: "2026-11-19T10:00:00.000Z" }),
	},
	{ label: "Key missing", row: key() },
];

export function AiAccountsPlate() {
	return (
		<AuditPlate
			description="The AI accounts page's rows: GitHub Copilot through the sign-in with and without a seat, checking as the page opens or with a check unfinished, a token that couldn't switch back, and an API key connected, unreadable or missing."
			item="ai-accounts"
			title="AI accounts"
		>
			<div className="design-audit-ai-accounts">
				{SPECIMENS.map(({ label, problem, row }) => (
					<div key={label}>
						<StateLabel>{label}</StateLabel>
						<ul className="ai-accounts-list">
							<AccountRowView onAction={() => {}} problem={problem} row={row} />
						</ul>
					</div>
				))}
			</div>
		</AuditPlate>
	);
}
