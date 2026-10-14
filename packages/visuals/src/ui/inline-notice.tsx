import { WarningIcon } from "@chopin/icons";
import type { ReactNode } from "react";
import type { SemanticTone } from "./semantic-tone";

export type InlineNoticeProps = {
	message: ReactNode;
	actions?: ReactNode;
	/** What happened, above the message; its actions then sit under both. */
	title?: ReactNode;
	tone?: SemanticTone;
};

export function InlineNotice({ message, actions, title, tone = "warning" }: InlineNoticeProps) {
	return (
		<div
			className="cv-inline-notice cv-semantic"
			data-titled={title ? "" : undefined}
			data-tone={tone}
			role="alert"
		>
			<WarningIcon aria-hidden="true" className="cv-inline-notice-icon" />
			<span className="cv-inline-notice-message">
				{title && <span className="cv-inline-notice-title">{title}</span>}
				{message}
			</span>
			{actions && <div className="cv-inline-notice-actions">{actions}</div>}
		</div>
	);
}
