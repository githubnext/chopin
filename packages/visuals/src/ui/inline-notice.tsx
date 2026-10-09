import { WarningIcon } from "@chopin/icons";
import type { ReactNode } from "react";
import type { SemanticTone } from "./semantic-tone";

export type InlineNoticeProps = {
	message: ReactNode;
	actions?: ReactNode;
	tone?: SemanticTone;
};

export function InlineNotice({ message, actions, tone = "warning" }: InlineNoticeProps) {
	return (
		<div className="cv-inline-notice cv-semantic" data-tone={tone} role="alert">
			<WarningIcon aria-hidden="true" className="cv-inline-notice-icon" />
			<span className="cv-inline-notice-message">{message}</span>
			{actions && <div className="cv-inline-notice-actions">{actions}</div>}
		</div>
	);
}
