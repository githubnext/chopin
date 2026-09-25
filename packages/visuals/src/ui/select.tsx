import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronIcon } from "@chopin/icons";

export const Select = SelectPrimitive.Root;

export function SelectValue({
	className = "",
	"data-slot": _dataSlot,
	...props
}: Omit<SelectPrimitive.Value.Props, "className"> & {
	className?: string;
	"data-slot"?: string;
}) {
	return (
		<SelectPrimitive.Value
			{...props}
			className={`cv-select-value ${className}`.trim()}
			data-slot="select-value"
		/>
	);
}

export function SelectTrigger({
	children,
	className = "",
	"data-slot": _dataSlot,
	...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & {
	className?: string;
	"data-slot"?: string;
}) {
	return (
		<SelectPrimitive.Trigger
			{...props}
			className={`cv-select-trigger ${className}`.trim()}
			data-slot="select-trigger"
		>
			{children}
			<SelectPrimitive.Icon className="cv-select-chevron" data-slot="select-icon">
				<ChevronIcon aria-hidden="true" size={14} />
			</SelectPrimitive.Icon>
		</SelectPrimitive.Trigger>
	);
}

type SelectContentProps =
	& Omit<SelectPrimitive.Popup.Props, "className">
	& Pick<SelectPrimitive.Positioner.Props, "align" | "side" | "sideOffset">
	& { className?: string; "data-slot"?: string };

export function SelectContent({
	align = "start",
	children,
	className = "",
	"data-slot": _dataSlot,
	side = "bottom",
	sideOffset = 4,
	...props
}: SelectContentProps) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				align={align}
				alignItemWithTrigger={false}
				className="cv-select-positioner"
				collisionPadding={8}
				side={side}
				sideOffset={sideOffset}
			>
				<SelectPrimitive.Popup
					{...props}
					className={`cv-select-popup ${className}`.trim()}
					data-slot="select-popup"
				>
					<SelectPrimitive.ScrollUpArrow className="cv-select-scroll cv-select-scroll-up">
						<ChevronIcon aria-hidden="true" size={14} />
					</SelectPrimitive.ScrollUpArrow>
					<SelectPrimitive.List className="cv-select-listbox" data-slot="select-listbox">
						{children}
					</SelectPrimitive.List>
					<SelectPrimitive.ScrollDownArrow className="cv-select-scroll cv-select-scroll-down">
						<ChevronIcon aria-hidden="true" size={14} />
					</SelectPrimitive.ScrollDownArrow>
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

export function SelectItem({
	children,
	className = "",
	"data-slot": _dataSlot,
	...props
}: Omit<SelectPrimitive.Item.Props, "className"> & {
	className?: string;
	"data-slot"?: string;
}) {
	return (
		<SelectPrimitive.Item
			{...props}
			className={`cv-select-item ${className}`.trim()}
			data-slot="select-item"
		>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator className="cv-select-check" data-slot="select-checkmark">
				<CheckIcon aria-hidden="true" size={14} />
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}
