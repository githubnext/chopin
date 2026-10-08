import type { IconProps } from "@chopin/icons";
import type { ComponentProps, ComponentType } from "react";

import { IconLabel } from "./icon-label";
import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type BadgeProps = Omit<ComponentProps<"span">, "children"> & {
	icon: ComponentType<IconProps>;
	label: string;
	/** `sm` is a compact, borderless status label for dense chrome such as headers. */
	size?: "md" | "sm";
	tone?: SemanticTone;
};

export function Badge(
	{ className, icon, label, size = "md", tone = "neutral", ...props }: BadgeProps,
) {
	return (
		<span
			{...props}
			className={semanticClasses("cv-badge", className)}
			data-size={size}
			data-slot="badge"
			data-tone={tone}
		>
			<IconLabel icon={icon} label={label} tone={tone} />
		</span>
	);
}
