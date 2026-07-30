import type { Effort } from "./effort";
import { resolveWireModelId } from "./model-thinking";
import type { Api, InputModality, KnownApi, Model, ResolvedModelRoute, SupportedMediaForm } from "./types";

export interface MediaTransportPolicy {
	readonly user: readonly SupportedMediaForm[];
	readonly toolResult: readonly SupportedMediaForm[];
}

const NONE: readonly SupportedMediaForm[] = Object.freeze([]);
const WAV: SupportedMediaForm = Object.freeze({
	modality: "audio",
	mimeTypes: Object.freeze(["audio/wav", "audio/x-wav"]),
	wireShape: "input_audio",
	normalizedFormat: "wav",
});
const MP3: SupportedMediaForm = Object.freeze({
	modality: "audio",
	mimeTypes: Object.freeze(["audio/mpeg", "audio/mp3"]),
	wireShape: "input_audio",
	normalizedFormat: "mp3",
});
const OPENAI_AUDIO = Object.freeze([WAV, MP3]);
const GOOGLE_AUDIO: SupportedMediaForm = Object.freeze({
	modality: "audio",
	mimeTypes: Object.freeze([
		"audio/wav",
		"audio/mp3",
		"audio/aiff",
		"audio/aac",
		"audio/ogg",
		"audio/flac",
		"audio/mp4",
		"audio/m4a",
		"audio/webm",
	]),
	wireShape: "inlineData",
});
const GOOGLE_VIDEO: SupportedMediaForm = Object.freeze({
	modality: "video",
	mimeTypes: Object.freeze([
		"video/mp4",
		"video/mpeg",
		"video/mov",
		"video/avi",
		"video/x-flv",
		"video/mpg",
		"video/webm",
		"video/wmv",
		"video/3gpp",
	]),
	wireShape: "inlineData",
});
const GOOGLE_MEDIA = Object.freeze([GOOGLE_AUDIO, GOOGLE_VIDEO]);
const unsupported = (): MediaTransportPolicy => ({ user: NONE, toolResult: NONE });

/**
 * Exhaustive transport truth for the 14 built-in APIs on this branch. Vendor
 * metadata is deliberately absent from this table: an encoder exists or it
 * does not. Bedrock video remains off until a primary-source exact Nova route
 * allowlist is available on this branch.
 */
export const BUILTIN_MEDIA_POLICIES: Readonly<Record<KnownApi, MediaTransportPolicy>> = Object.freeze({
	"openai-completions": { user: OPENAI_AUDIO, toolResult: NONE },
	"openai-responses": { user: OPENAI_AUDIO, toolResult: NONE },
	openrouter: { user: OPENAI_AUDIO, toolResult: NONE },
	"openai-codex-responses": unsupported(),
	"azure-openai-responses": { user: OPENAI_AUDIO, toolResult: NONE },
	"anthropic-messages": unsupported(),
	"bedrock-converse-stream": unsupported(),
	"google-generative-ai": { user: GOOGLE_MEDIA, toolResult: NONE },
	"google-gemini-cli": unsupported(),
	"google-vertex": { user: GOOGLE_MEDIA, toolResult: NONE },
	"ollama-chat": unsupported(),
	"cursor-agent": unsupported(),
	"gitlab-duo-agent": unsupported(),
	"devin-agent": unsupported(),
});

function policyFor(api: Api): MediaTransportPolicy {
	return Object.hasOwn(BUILTIN_MEDIA_POLICIES, api)
		? BUILTIN_MEDIA_POLICIES[api as KnownApi]
		: { user: NONE, toolResult: NONE };
}

function effectiveInput(vendorInput: readonly InputModality[], forms: readonly SupportedMediaForm[]): InputModality[] {
	const effective: InputModality[] = [];
	if (vendorInput.includes("text")) effective.push("text");
	if (vendorInput.includes("image")) effective.push("image");
	if (vendorInput.includes("audio") && forms.some(form => form.modality === "audio")) effective.push("audio");
	if (vendorInput.includes("video") && forms.some(form => form.modality === "video")) effective.push("video");
	return effective;
}

export function resolveEffectiveMediaCapabilities(
	api: Api,
	vendorInput: readonly InputModality[],
): Pick<ResolvedModelRoute, "input" | "toolResultInput" | "userMediaForms" | "toolResultMediaForms"> {
	const policy = policyFor(api);
	return {
		input: effectiveInput(vendorInput, policy.user),
		toolResultInput: effectiveInput(vendorInput, policy.toolResult),
		userMediaForms: policy.user,
		toolResultMediaForms: policy.toolResult,
	};
}

export function resolveModelRoute<TApi extends Api>(
	model: Model<TApi>,
	effort?: Effort,
	explicitWireModelId?: string,
): ResolvedModelRoute {
	const wireModelId = explicitWireModelId ?? resolveWireModelId(model, effort);
	const defaultVendorInput = model.vendorInput ?? model.input;
	// Bundled models predate per-wire vendor evidence (models.json was not
	// regenerated for audio/video), so an unannotated routed id must fall back
	// to the model's default vendor input rather than resolving to an empty
	// capability set that silently drops supported media.
	const vendorInput = model.vendorInputByWireModel?.[wireModelId] ?? defaultVendorInput;
	return {
		wireModelId,
		vendorInput,
		...resolveEffectiveMediaCapabilities(model.api, vendorInput),
	};
}

export function withResolvedModelRoute<TApi extends Api>(model: Model<TApi>, route: ResolvedModelRoute): Model<TApi> {
	return {
		...model,
		requestModelId: route.wireModelId,
		vendorInput: [...route.vendorInput],
		input: [...route.input],
		toolResultInput: [...route.toolResultInput],
	};
}

export function findSupportedMediaForm(
	forms: readonly SupportedMediaForm[],
	modality: "audio" | "video",
	mimeType: string,
): SupportedMediaForm | undefined {
	const normalizedMime = mimeType.toLowerCase();
	return forms.find(form => form.modality === modality && form.mimeTypes.includes(normalizedMime));
}
