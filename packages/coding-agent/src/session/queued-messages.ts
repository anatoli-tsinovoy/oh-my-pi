import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AudioContent, ImageContent, VideoContent } from "@oh-my-pi/pi-ai";
import type { RestoredQueuedMessage } from "./agent-session-types";
import { type CustomMessage, readQueueChipText } from "./messages";

function queuedTextContent(message: AgentMessage): string | undefined {
	if (!("content" in message)) return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return undefined;
}

function queuedBlocksOfType<T extends ImageContent | AudioContent | VideoContent>(
	message: AgentMessage,
	type: T["type"],
): T[] | undefined {
	if (!("content" in message) || typeof message.content === "string") return undefined;
	const blocks: T[] = [];
	for (const part of message.content) {
		if (part.type === type && typeof part.data === "string" && typeof part.mimeType === "string") {
			blocks.push(part as T);
		}
	}
	return blocks.length > 0 ? blocks : undefined;
}

/** Whether a queued message should render in the queue UI. */
export function isDisplayableQueuedMessage(message: AgentMessage): boolean {
	return !(message.role === "custom" && message.display === false);
}

/** Whether a queued message is an advisor card. */
export function isAdvisorCard(message: AgentMessage): message is CustomMessage {
	return message.role === "custom" && message.customType === "advisor";
}

/** Whether a message is a terminal assistant answer containing text and no tools. */
export function isTerminalTextAssistantAnswer(message: AgentMessage | undefined): message is AssistantMessage {
	if (message?.role !== "assistant" || message.stopReason !== "stop") return false;
	let hasText = false;
	for (const part of message.content) {
		if (part.type === "toolCall") return false;
		if (part.type === "text") {
			if (part.text.trim().length > 0) hasText = true;
			continue;
		}
		if (
			part.type === "thinking" ||
			part.type === "redactedThinking" ||
			part.type === "fallback" ||
			part.type === "anthropicServerTool"
		)
			continue;
		return false;
	}
	return hasText;
}

/** Whether queued content was authored by the user and can be restored to the editor. */
export function isUserQueuedMessage(message: AgentMessage): boolean {
	if (message.role === "user") return true;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

/** Hidden magic-keyword notices queued alongside a user prompt. */
export const MAGIC_KEYWORD_NOTICE_TYPES: Record<string, true> = {
	"ultrathink-notice": true,
	"orchestrate-notice": true,
	"workflow-notice": true,
};

/** Hidden companion carrying vision descriptions for a text-only model. */
export const IMAGE_ATTACHMENT_DESCRIPTION_TYPE = "image-attachment-description";

/** Whether a hidden queued message is a companion of an adjacent user prompt. */
export function isHiddenUserCompanion(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		message.attribution === "user" &&
		message.display === false &&
		(MAGIC_KEYWORD_NOTICE_TYPES[message.customType] === true ||
			message.customType === IMAGE_ATTACHMENT_DESCRIPTION_TYPE)
	);
}

/** Human-readable text shown for a queued-message chip. */
export function queueChipText(message: AgentMessage): string {
	if (message.role === "custom") {
		return readQueueChipText(message.details) ?? queuedTextContent(message) ?? "";
	}
	const text = queuedTextContent(message) ?? "";
	if (text) return text;
	if (queuedBlocksOfType<ImageContent>(message, "image")) return "[Image]";
	if (queuedBlocksOfType<AudioContent>(message, "audio")) return "[Audio]";
	if (queuedBlocksOfType<VideoContent>(message, "video")) return "[Video]";
	return "";
}

/** Converts a queued user message to editor-restorable content. */
export function toRestoredQueuedMessage(message: AgentMessage): RestoredQueuedMessage {
	return {
		text: queueChipText(message),
		images: queuedBlocksOfType<ImageContent>(message, "image"),
		audio: queuedBlocksOfType<AudioContent>(message, "audio"),
		video: queuedBlocksOfType<VideoContent>(message, "video"),
	};
}
