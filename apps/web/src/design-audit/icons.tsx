import {
	ArchiveIcon,
	ArrowUpIcon,
	CheckIcon,
	ChevronIcon,
	CloseIcon,
	DocumentIcon,
	InfoIcon,
	LightbulbIcon,
	LoaderIcon,
	MessageIcon,
	PlusIcon,
	SearchIcon,
	SignInIcon,
	SirenIcon,
	SparkleIcon,
	WarningIcon,
} from "@chopin/icons";

import addProject from "../assets/figma/navigation/add-project.svg";
import archive from "../assets/figma/navigation/box-archive.svg";
import book from "../assets/figma/navigation/book-bookmark.svg";
import chopin from "../assets/figma/navigation/chopin.svg";
import documentActions from "../assets/figma/navigation/document-actions.svg";
import newDocument from "../assets/figma/navigation/new-document.svg";
import search from "../assets/figma/navigation/search.svg";
import panelClose from "../assets/icons/panel-close.svg";
import conversation from "../assets/icons/conversation.svg";
import navigationChevron from "../assets/icons/navigation-chevron-right.svg";
import plannerStop from "../assets/icons/planner-stop.svg";
import linkPlus from "../../../../packages/editor/src/assets/icons/link-plus.svg";
import messagePlus from "../../../../packages/editor/src/assets/icons/message-plus.svg";

import type { IconProps } from "@chopin/icons";
import type { ComponentType } from "react";

type IconCatalogueItem = {
	className?: string;
	duplicate?: string;
	icon?: ComponentType<IconProps>;
	name: string;
	source?: string;
};

const NUCLEO_ICONS: readonly IconCatalogueItem[] = [
	{ name: "Add project", source: addProject },
	{ name: "Book bookmark", source: book },
	{ name: "Archive", source: archive },
	{ name: "Chopin", source: chopin },
	{
		duplicate: "collapse.svg and conversation-close.svg consolidated",
		name: "Panel close",
		source: panelClose,
	},
	{ name: "Document actions", source: documentActions },
	{ name: "New document", source: newDocument },
	{ name: "Search", source: search },
	{ name: "Conversation", source: conversation },
	{ name: "Navigation chevron", source: navigationChevron },
	{ name: "Planner stop", source: plannerStop },
	{ name: "Link plus", source: linkPlus },
	{ name: "Message plus", source: messagePlus },
	{ icon: ArrowUpIcon, name: "Arrow up" },
	{ icon: ChevronIcon, name: "Chevron right" },
	{ className: "rotate-90", icon: ChevronIcon, name: "Chevron down (rotated)" },
	{ icon: MessageIcon, name: "Message" },
	{ icon: CheckIcon, name: "Check" },
	{ icon: InfoIcon, name: "Info" },
	{ icon: LightbulbIcon, name: "Lightbulb" },
	{ icon: PlusIcon, name: "Plus" },
	{ icon: CloseIcon, name: "Close" },
	{ icon: SignInIcon, name: "Sign in" },
	{ icon: SirenIcon, name: "Siren" },
	{ icon: SparkleIcon, name: "Important sparkle" },
	{ icon: WarningIcon, name: "Warning" },
	{ icon: ArchiveIcon, name: "Archive" },
	{ icon: DocumentIcon, name: "Document" },
	{ icon: SearchIcon, name: "Search" },
	{ icon: LoaderIcon, name: "Loader" },
];

export function IconCatalogue() {
	return (
		<div className="design-audit-icon-catalogue">
			<div className="design-audit-icon-states" aria-label="Icon colour states">
				{(["Default", "Active", "Disabled"] as const).map(state => (
					<div data-icon-state={state.toLowerCase()} key={state}>
						<CheckIcon aria-hidden="true" size={14} />
						<span>{state}</span>
					</div>
				))}
			</div>
			<h4>Nucleo icons</h4>
			<div className="design-audit-icon-grid">
				{NUCLEO_ICONS.map(({ className, duplicate, icon: Glyph, name, source }) => (
					<figure key={`${source ? "asset" : "component"}-${name}`}>
						<span className="design-audit-icon-frame">
							{source ? <img alt="" src={source} /> : null}
							{Glyph ? <Glyph aria-hidden="true" className={className} size={14} /> : null}
						</span>
						<figcaption>
							<strong>{name}</strong>
							{duplicate ? <span>Consolidated exact duplicate: {duplicate}</span> : null}
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
						<span>{label} · {size}px</span>
					</div>
				))}
			</div>
		</div>
	);
}
