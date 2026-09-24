import type { IconProps } from "@chopin/icons";
import type { ComponentProps, ComponentType } from "react";

import { IconLabel } from "./icon-label";
import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type BadgeProps = Omit<ComponentProps<"span">, "children"> & {
	icon: ComponentType<IconProps>;
	label: string;
	tone?: SemanticTone;
};

export function Badge({ className, icon, label, tone = "neutral", ...props }: BadgeProps) {
	return (
		<span
			{...props}
			className={semanticClasses("cv-badge", className)}
			data-slot="badge"
			data-tone={tone}
		>
			<IconLabel icon={icon} label={label} tone={tone} />
		</span>
	);
}
