import { readTextFromClipboard } from "../../../../utils/clipboard";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";

const PASTE_TEXT_TITLE = "Paste text to annotate";

function isSshSession(): boolean {
	const env = process.env;
	return Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
}

/** Read native clipboard text, with an interactive paste fallback for SSH/local failures. */
export async function acquireClipboardText(ctx: CustomCommandContext): Promise<string | undefined> {
	if (!isSshSession()) {
		try {
			const text = await readTextFromClipboard();
			if (text.trim().length > 0) return text;
			ctx.ui.notify("Clipboard has no text; paste text to annotate instead.", "warning");
		} catch {
			ctx.ui.notify("Unable to read the local clipboard automatically; paste text to annotate instead.", "warning");
		}
	} else {
		ctx.ui.notify(
			"Clipboard auto-read is disabled over SSH to avoid reading the remote clipboard; paste text to annotate instead.",
			"warning",
		);
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("An interactive session is required to paste text to annotate.", "warning");
		return undefined;
	}
	const pasted = await ctx.ui.editor(PASTE_TEXT_TITLE);
	if (pasted === undefined) return undefined;
	if (pasted.trim().length === 0) {
		ctx.ui.notify("No text was pasted to annotate.", "warning");
		return undefined;
	}
	return pasted;
}
