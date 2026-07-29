import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	findSupportedMediaForm,
	resolveModelRoute,
	withResolvedModelRoute,
} from "@oh-my-pi/pi-catalog/media-capabilities";
import type { Api, Model, ResolvedModelRoute } from "@oh-my-pi/pi-catalog/types";
import { type MediaInputPosition, UnsupportedMediaError } from "./error/validation";
import type { Context, Message } from "./types";

function assertSupported(
	model: Model<Api>,
	route: ResolvedModelRoute,
	media: { type: "audio" | "video"; mimeType: string },
	position: MediaInputPosition,
	toolResult: boolean,
): void {
	const modalities = toolResult ? route.toolResultInput : route.input;
	const forms = toolResult ? route.toolResultMediaForms : route.userMediaForms;
	if (modalities.includes(media.type) && findSupportedMediaForm(forms, media.type, media.mimeType)) return;
	throw new UnsupportedMediaError({
		provider: model.provider,
		wireModel: route.wireModelId,
		mediaType: media.type,
		mimeType: media.mimeType,
		position,
		supportedForms: forms.filter(form => form.modality === media.type),
	});
}

/**
 * Validates every inbound audio/video block against one exact routed model.
 * Callers use the returned model for serialization so validation and wire
 * routing cannot diverge.
 */
export function validateContextMedia<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	effort?: Effort,
	explicitWireModelId?: string,
): Model<TApi> {
	const route = resolveModelRoute(model, effort, explicitWireModelId);
	for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex++) {
		const message = context.messages[messageIndex];
		if (message.role === "user" || message.role === "developer") {
			if (typeof message.content === "string") continue;
			for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
				const block = message.content[contentIndex];
				if (block.type !== "audio" && block.type !== "video") continue;
				assertSupported(
					model,
					route,
					block,
					Object.freeze({ kind: "message", messageIndex, contentIndex, role: message.role }),
					false,
				);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
			const block = message.content[contentIndex];
			if (block.type !== "audio" && block.type !== "video") continue;
			assertSupported(
				model,
				route,
				block,
				Object.freeze({
					kind: "toolResult",
					messageIndex,
					contentIndex,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				}),
				true,
			);
		}
	}
	return withResolvedModelRoute(model, route);
}

/** Converter-level guard for entry points that receive message arrays. */
export function validateMessagesMedia<TApi extends Api>(
	model: Model<TApi>,
	messages: readonly Message[],
	effort?: Effort,
): Model<TApi> {
	return validateContextMedia(model, { messages: [...messages] }, effort);
}
