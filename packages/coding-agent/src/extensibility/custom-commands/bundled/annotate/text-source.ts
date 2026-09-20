import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CopySelection } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import type { SessionEntry } from "../../../../session/session-entries";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";

export type AnnotationSourceKind = "code-review" | "last" | "session" | "clipboard";

export const ANNOTATION_SOURCE_CHOICES = [
	{
		kind: "code-review",
		label: "Code review",
		description: "Annotate a local diff before review",
	},
	{
		kind: "last",
		label: "Latest assistant reply",
		description: "Annotate the latest non-empty assistant reply on this branch",
	},
	{
		kind: "session",
		label: "Session message or block",
		description: "Choose a message, code block, quote, or command from this session",
	},
	{
		kind: "clipboard",
		label: "Clipboard text",
		description: "Read text from the system clipboard",
	},
] as const satisfies ReadonlyArray<{ kind: AnnotationSourceKind; label: string; description: string }>;

export async function selectAnnotationSourceKind(
	ui: Pick<CustomCommandContext["ui"], "select">,
): Promise<AnnotationSourceKind | undefined> {
	const selected = await ui.select(
		"Select content to annotate",
		ANNOTATION_SOURCE_CHOICES.map(choice => choice.label),
	);
	return ANNOTATION_SOURCE_CHOICES.find(choice => choice.label === selected)?.kind;
}

function assistantText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() ? text : undefined;
}

function latestAssistantEntry(branch: readonly SessionEntry[]): { id: string; text: string } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		const text = assistantText(entry.message);
		if (text) return { id: entry.id, text };
	}
	return undefined;
}

function sourceKind(selection: CopySelection): TextReviewSource["kind"] {
	switch (selection.kind) {
		case "code":
		case "output":
			return "code";
		case "quote":
			return "quote";
		case "command":
			return "command";
		default:
			return "message";
	}
}

function sourceFromSelection(
	ctx: CustomCommandContext,
	selection: CopySelection,
	latestAssistantId: string | undefined,
): TextReviewSource {
	const kind = sourceKind(selection);
	const provenance =
		selection.entryId === undefined
			? undefined
			: selection.entryId === latestAssistantId && selection.kind === "message"
				? { kind: "latest-assistant" as const, entryId: selection.entryId }
				: { kind: "session" as const, entryId: selection.entryId };
	return {
		id: selection.entryId ? `${selection.kind}:${selection.entryId}` : `selection:${selection.kind}`,
		kind,
		label: selection.label,
		text: selection.content,
		provenance,
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

/** Choose exact content via the host's native `/copy` selector. */
export async function selectSessionTextReviewSource(
	ctx: CustomCommandContext,
	options?: { autoSelect?: "latest-assistant" },
): Promise<TextReviewSource | undefined> {
	const branch = ctx.sessionManager.getBranch();
	const latest = latestAssistantEntry(branch);
	if (options?.autoSelect === "latest-assistant") {
		if (!latest) {
			ctx.ui.notify("No non-empty assistant reply is available on the active session branch.", "warning");
			return undefined;
		}
		return {
			id: `message:${latest.id}`,
			kind: "message",
			label: "Latest assistant reply",
			text: latest.text,
			provenance: { kind: "latest-assistant", entryId: latest.id },
			sessionId: ctx.sessionManager.getSessionId(),
		};
	}
	const selection = await ctx.ui.selectMessage();
	return selection ? sourceFromSelection(ctx, selection, latest?.id) : undefined;
}

/** Capture clipboard text as a distinct annotation source. */
export function createClipboardTextReviewSource(ctx: CustomCommandContext, text: string): TextReviewSource {
	return {
		id: "clipboard",
		kind: "clipboard",
		label: "Clipboard text",
		text,
		provenance: { kind: "clipboard" },
		sessionId: ctx.sessionManager.getSessionId(),
	};
}
