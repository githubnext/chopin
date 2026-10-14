import { useTransitionPresence } from "@chopin/editor/transition-presence";

import { motionImmediately } from "../motion-input";
import { ResearchAgendaDialog } from "./dialog";

import type { Research } from "@chopin/protocol";

import "./style.css";

export type ResearchAgendaProps = {
	channelId: string;
	open: boolean;
	onDismiss: () => void;
	onOpenChild?: (child: Research.ReadyChild) => Promise<boolean>;
};

export function ResearchAgenda({ channelId, open, onDismiss, onOpenChild }: ResearchAgendaProps) {
	let presence = useTransitionPresence(open ? channelId : undefined, 150, motionImmediately());
	if (presence.phase === "closed") return null;
	return (
		<ResearchAgendaDialog
			active={open}
			channelId={presence.value}
			key={presence.value}
			motion={presence}
			onDismiss={onDismiss}
			onOpenChild={onOpenChild}
		/>
	);
}

export default ResearchAgenda;
