import {
	ArrowUpIcon,
	CaretDownIcon,
	CaretRightIcon,
	ChatCircleIcon,
	CheckIcon,
	InfoIcon,
	LightbulbIcon,
	PlusIcon,
	SignInIcon,
	SirenIcon,
	StarFourIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";

import addProject from "../assets/figma/navigation/add-project.svg";
import archive from "../assets/figma/navigation/box-archive.svg";
import book from "../assets/figma/navigation/book-bookmark.svg";
import chopin from "../assets/figma/navigation/chopin.svg";
import documentActions from "../assets/figma/navigation/document-actions.svg";
import newDocument from "../assets/figma/navigation/new-document.svg";
import search from "../assets/figma/navigation/search.svg";
import hideSidebar from "../assets/figma/navigation/sidebar-right-3-hide.svg";
import panelClose from "../assets/icons/panel-close.svg";
import conversation from "../assets/icons/conversation.svg";
import navigationChevron from "../assets/icons/navigation-chevron-right.svg";
import navigationXmark from "../assets/icons/navigation-xmark.svg";
import plannerStop from "../assets/icons/planner-stop.svg";
import sendArrow from "../assets/icons/send-arrow-up.svg";
import toolChevronDown from "../assets/icons/tool-chevron-down.svg";
import toolChevronRight from "../assets/icons/tool-chevron-right.svg";
import toolLoader from "../assets/icons/tool-loader.svg";
import linkPlus from "../../../../packages/editor/src/assets/icons/link-plus.svg";
import messagePlus from "../../../../packages/editor/src/assets/icons/message-plus.svg";

import type { Icon } from "@phosphor-icons/react";

type LocalIcon = {
	duplicate?: string;
	name: string;
	source: string;
};

const LOCAL_ICONS: readonly LocalIcon[] = [
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
	{ name: "Hide sidebar", source: hideSidebar },
	{ name: "Conversation", source: conversation },
	{ name: "Navigation chevron", source: navigationChevron },
	{ name: "Navigation close", source: navigationXmark },
	{ name: "Planner stop", source: plannerStop },
	{ name: "Send", source: sendArrow },
	{ name: "Tool chevron down", source: toolChevronDown },
	{ name: "Tool chevron right", source: toolChevronRight },
	{ name: "Tool loader", source: toolLoader },
	{ name: "Link plus", source: linkPlus },
	{ name: "Message plus", source: messagePlus },
];

const PHOSPHOR_ICONS: readonly { icon: Icon; name: string }[] = [
	{ icon: ArrowUpIcon, name: "Arrow up" },
	{ icon: CaretDownIcon, name: "Caret down" },
	{ icon: CaretRightIcon, name: "Caret right" },
	{ icon: ChatCircleIcon, name: "Chat circle" },
	{ icon: CheckIcon, name: "Check" },
	{ icon: InfoIcon, name: "Info" },
	{ icon: LightbulbIcon, name: "Lightbulb" },
	{ icon: PlusIcon, name: "Plus" },
	{ icon: SignInIcon, name: "Sign in" },
	{ icon: SirenIcon, name: "Siren" },
	{ icon: StarFourIcon, name: "Important" },
	{ icon: WarningIcon, name: "Warning" },
	{ icon: XIcon, name: "Close" },
];

export function IconCatalogue() {
	return (
		<div className="design-audit-icon-catalogue">
			<div className="design-audit-icon-states" aria-label="Icon colour states">
				{(["Default", "Active", "Disabled"] as const).map(state => (
					<div data-icon-state={state.toLowerCase()} key={state}>
						<CheckIcon aria-hidden="true" size={16} />
						<span>{state}</span>
					</div>
				))}
			</div>
			<h4>Local SVG assets</h4>
			<div className="design-audit-icon-grid">
				{LOCAL_ICONS.map(icon => (
					<figure key={icon.name}>
						<span className="design-audit-icon-frame">
							<img alt="" src={icon.source} />
						</span>
						<figcaption>
							<strong>{icon.name}</strong>
							{icon.duplicate ? <span>Consolidated exact duplicate: {icon.duplicate}</span> : null}
						</figcaption>
					</figure>
				))}
			</div>
			<h4>Phosphor components</h4>
			<div className="design-audit-icon-grid">
				{PHOSPHOR_ICONS.map(({ icon: Glyph, name }) => (
					<figure key={name}>
						<span className="design-audit-icon-frame">
							<Glyph aria-hidden="true" size={16} />
						</span>
						<figcaption>
							<strong>{name}</strong>
						</figcaption>
					</figure>
				))}
			</div>
			<div className="design-audit-icon-sizes" aria-label="Icon size roles">
				{([14, 16, 20] as const).map(size => (
					<div key={size}>
						<ChatCircleIcon aria-hidden="true" size={size} />
						<span>{size}px</span>
					</div>
				))}
			</div>
		</div>
	);
}
