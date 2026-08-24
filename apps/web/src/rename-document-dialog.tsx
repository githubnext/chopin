import { DocumentRename } from "./document-rename";
import { NavigationDialog } from "./navigation-dialog";

import type * as Api from "./api";
import type { NavigationDialogMotion } from "./navigation-dialog";

export function RenameDocumentDialog(
	{
		channel,
		motion,
		onDismiss,
		onRenamed,
	}: {
		channel: Api.Channel;
		motion: NavigationDialogMotion;
		onDismiss: () => void;
		onRenamed: (channel: Api.Channel) => void;
	},
) {
	return (
		<NavigationDialog motion={motion} onDismiss={onDismiss} title="Rename document">
			<DocumentRename
				channel={channel}
				className="mt-4"
				onCancel={onDismiss}
				onRenamed={detail => {
					onRenamed(detail.channel);
					onDismiss();
				}}
			/>
		</NavigationDialog>
	);
}
