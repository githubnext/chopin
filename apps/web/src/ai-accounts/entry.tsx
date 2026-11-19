import { KeyIcon } from "@chopin/icons";

export function AiAccountsEntry(
	{ current = false, placement }: { current?: boolean; placement: "sidebar" | "sheet" },
) {
	return (
		<a
			aria-current={current ? "page" : undefined}
			className={placement === "sheet" ? "documents-sheet-link" : "project-sidebar-primary-action"}
			href="/ai-accounts"
		>
			<KeyIcon aria-hidden="true" className="ai-accounts-entry-icon" />
			<span className="truncate">AI accounts</span>
		</a>
	);
}
