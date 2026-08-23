import { DocumentRename } from "./document-rename";
import { NavigationDialog } from "./navigation-dialog";

import type * as Api from "./api";

export function RenameDocumentDialog(
	{
		channel,
		onDismiss,
		onRenamed,
	}: {
		channel: Api.Channel;
		onDismiss: () => void;
		onRenamed: (channel: Api.Channel) => void;
	},
) {
	return (
		<NavigationDialog onDismiss={onDismiss} title="Rename document">
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
