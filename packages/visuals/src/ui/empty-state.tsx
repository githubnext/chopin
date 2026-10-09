import type { IconProps } from "@chopin/icons";
import type { ComponentType, ReactNode } from "react";

export type EmptyStateProps = {
	icon: ComponentType<IconProps>;
	title?: ReactNode;
	description: ReactNode;
	action?: ReactNode;
	appearance?: "plain" | "framed";
	density?: "default" | "compact";
	measure?: "standard" | "short";
};

export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	appearance = "plain",
	density = "default",
	measure = "standard",
}: EmptyStateProps) {
	return (
		<div
			className="cv-empty-state"
			data-slot="empty-state"
			data-appearance={appearance}
			data-density={density}
			data-measure={measure}
		>
			<span aria-hidden="true" className="cv-empty-state-icon-frame">
				<Icon className="cv-empty-state-icon" />
			</span>
			<div className="cv-empty-state-copy">
				{title && <h3 className="cv-empty-state-title">{title}</h3>}
				<p className="cv-empty-state-description">{description}</p>
			</div>
			{action && <div className="cv-empty-state-action">{action}</div>}
		</div>
	);
}
