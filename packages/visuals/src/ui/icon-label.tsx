import type { IconProps } from "@chopin/icons";
import type { ComponentProps, ComponentType } from "react";

import { semanticClasses } from "./semantic-tone";
import type { SemanticTone } from "./semantic-tone";

export type IconLabelProps = Omit<ComponentProps<"span">, "children"> & {
	icon: ComponentType<IconProps>;
	label: string;
	tone?: SemanticTone;
};

export function IconLabel({
	className,
	icon: Icon,
	label,
	tone = "neutral",
	...props
}: IconLabelProps) {
	return (
		<span
			{...props}
			className={semanticClasses("cv-icon-label", className)}
			data-slot="icon-label"
			data-tone={tone}
		>
			<span className="cv-icon-label-icon-frame" data-slot="icon-label-icon">
				<Icon aria-hidden="true" className="cv-icon-label-icon" size={14} />
			</span>
			<span className="cv-icon-label-text" data-slot="icon-label-text">
				{label}
			</span>
		</span>
	);
}
