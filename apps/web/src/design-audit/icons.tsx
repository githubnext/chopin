import {
	ArchiveIcon,
	ArrowUpIcon,
	CheckIcon,
	ChevronIcon,
	CircleCloseIcon,
	CloseIcon,
	DocumentIcon,
	ImageIcon,
	InfoIcon,
	InvestigationIcon,
	KeyboardIcon,
	LightbulbIcon,
	LinkPlusIcon,
	LoaderIcon,
	LockIcon,
	MachineIcon,
	MessageIcon,
	MessagePlusIcon,
	PlusIcon,
	ProgressHalfIcon,
	SearchIcon,
	ServerIcon,
	SignInIcon,
	SirenIcon,
	SparkleIcon,
	WarningIcon,
	WrenchIcon,
} from "@chopin/icons";

import addProject from "../assets/figma/navigation/add-project.svg";
import chopin from "../assets/figma/navigation/chopin.svg";
import documentActions from "../assets/figma/navigation/document-actions.svg";
import newDocument from "../assets/figma/navigation/new-document.svg";
import panelClose from "../assets/icons/panel-close.svg";
import chat from "../assets/icons/chat.svg";
import plannerResume from "../assets/icons/planner-resume.svg";
import plannerStop from "../assets/icons/planner-stop.svg";

import type { IconProps } from "@chopin/icons";
import type { ComponentType } from "react";

type IconCatalogueItem = {
	className?: string;
	icon?: ComponentType<IconProps>;
	name: string;
	source?: string;
};

const NUCLEO_ICONS: readonly IconCatalogueItem[] = [
	{ name: "Add project", source: addProject },
	{ name: "Chopin", source: chopin },
	{ name: "Panel close", source: panelClose },
	{ name: "Document actions", source: documentActions },
	{ name: "New document", source: newDocument },
	{ name: "Chat", source: chat },
	{ name: "Planner stop", source: plannerStop },
	{ name: "Planner resume", source: plannerResume },
	{ icon: LinkPlusIcon, name: "Link plus" },
	{ icon: MessagePlusIcon, name: "Message plus" },
	{ icon: ArrowUpIcon, name: "Arrow up" },
	{ icon: ChevronIcon, name: "Chevron right" },
	{ className: "rotate-90", icon: ChevronIcon, name: "Chevron down (rotated)" },
	{ icon: MessageIcon, name: "Message" },
	{ icon: CheckIcon, name: "Check" },
	{ icon: WrenchIcon, name: "Wrench" },
	{ icon: InfoIcon, name: "Info" },
	{ icon: KeyboardIcon, name: "Keyboard" },
	{ icon: ImageIcon, name: "Image" },
	{ icon: LightbulbIcon, name: "Lightbulb" },
	{ icon: PlusIcon, name: "Plus" },
	{ icon: CloseIcon, name: "Close" },
	{ icon: CircleCloseIcon, name: "Close in circle" },
	{ icon: ProgressHalfIcon, name: "Half progress" },
	{ icon: LockIcon, name: "Lock" },
	{ icon: SignInIcon, name: "Sign in" },
	{ icon: SirenIcon, name: "Siren" },
	{ icon: SparkleIcon, name: "Important sparkle" },
	{ icon: InvestigationIcon, name: "Investigation" },
	{ icon: WarningIcon, name: "Warning" },
	{ icon: ArchiveIcon, name: "Archive" },
	{ icon: DocumentIcon, name: "Document" },
	{ icon: SearchIcon, name: "Search" },
	{ icon: LoaderIcon, name: "Loader" },
	{ icon: MachineIcon, name: "Machine" },
	{ icon: ServerIcon, name: "Server" },
];

export function IconCatalogue() {
	return (
		<div className="design-audit-icon-catalogue">
			<div className="design-audit-icon-states" aria-label="Icon colour roles">
				<div data-icon-state="default">
					<CheckIcon aria-hidden="true" size={16} />
					<span>Default</span>
				</div>
				<div data-icon-state="danger">
					<WarningIcon aria-hidden="true" className="icon-danger" size={16} />
					<span>Danger</span>
				</div>
			</div>
			<h4>Nucleo icons</h4>
			<div className="design-audit-icon-grid">
				{NUCLEO_ICONS.map(({ className, icon: Glyph, name, source }) => (
					<figure key={`${source ? "asset" : "component"}-${name}`}>
						<span className="design-audit-icon-frame">
							{source ? <img alt="" src={source} /> : null}
							{Glyph ? <Glyph aria-hidden="true" className={className} size={16} /> : null}
						</span>
						<figcaption>
							<strong>{name}</strong>
						</figcaption>
					</figure>
				))}
			</div>
			<div className="design-audit-icon-sizes" aria-label="Icon size roles">
				{([
					{ label: "Interface", size: 14 },
					{ label: "Illustrative", size: 24 },
				] as const).map(({ label, size }) => (
					<div key={label}>
						<MessageIcon aria-hidden="true" size={size} />
						<span>{label} at {size}px</span>
					</div>
				))}
			</div>
		</div>
	);
}
