import { Popover } from "@base-ui/react/popover";

export function PriceRow() {
	return (
		<div className="price">
			<strong>$24</strong>
			<span>/ month</span>
		</div>
	);
}

export function BillingAction() {
	return (
		<Popover.Root>
			<Popover.Trigger className="action">Manage plan</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner sideOffset={8}>
					<Popover.Popup className="billing-popup">
						<Popover.Title>Studio plan</Popover.Title>
						<Popover.Description>Your next invoice is on November 1.</Popover.Description>
						<Popover.Close>Done</Popover.Close>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
