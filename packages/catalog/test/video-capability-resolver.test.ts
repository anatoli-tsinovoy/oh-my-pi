import { describe, expect, test } from "bun:test";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// mapModelsDevToModels must never advertise an input modality that the
// provider's wire converter would silently drop. The OpenAI Responses /
// Completions converters have no video transport and replace every video
// block with an omission placeholder, so `video` is stripped for every
// OpenAI-family wire API (audio survives — it is forwarded via input_audio).
// The Bedrock Converse converter has no audio OR video wire block either: it
// replaces both with `[unsupported …]` text placeholders, so both are
// stripped. APIs whose converters genuinely forward a modality (e.g. Google's
// inlineData parts) keep it.
const VIDEO_CAPABILITY_FIXTURE = {
	// openai descriptor -> api "openai-responses" (Responses converter).
	openai: {
		models: {
			"gpt-4o": {
				name: "GPT-4o",
				tool_call: true,
				modalities: { input: ["text", "image", "audio", "video"] },
				limit: { context: 128000, output: 16384 },
			},
		},
	},
	// azure descriptor -> api "azure-openai-responses" (same Responses converter).
	azure: {
		models: {
			"gpt-4o": {
				name: "GPT-4o",
				tool_call: true,
				modalities: { input: ["text", "image", "audio", "video"] },
				limit: { context: 128000, output: 16384 },
			},
		},
	},
	// google descriptor -> api "google-generative-ai" (Gemini forwards video).
	google: {
		models: {
			"gemini-3.5-flash": {
				name: "Gemini 3.5 Flash",
				tool_call: true,
				modalities: { input: ["text", "image", "audio", "video"] },
				limit: { context: 1_048_576, output: 65_536 },
			},
		},
	},
	// amazon-bedrock descriptor -> api "bedrock-converse-stream". The Converse
	// converter (convertMessages in amazon-bedrock.ts) has no audio or video
	// wire block and replaces both with `[unsupported …]` text placeholders, so
	// advertising either would lie about what the model accepts.
	"amazon-bedrock": {
		models: {
			"amazon.nova-pro-v1:0": {
				name: "Nova Pro",
				tool_call: true,
				modalities: { input: ["text", "image", "audio", "video"] },
				limit: { context: 300_000, output: 5_000 },
			},
		},
	},
} satisfies Record<string, unknown>;

describe("models.dev media capability filtering", () => {
	const mapped = mapModelsDevToModels(VIDEO_CAPABILITY_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS);
	const byProvider = (provider: string): ModelSpec => {
		const model = mapped.find(m => m.provider === provider);
		expect(model).toBeDefined();
		return model as ModelSpec;
	};

	test("openai-responses does not advertise video (Responses converter omits it)", () => {
		const openai = byProvider("openai");
		expect(openai.api).toBe("openai-responses");
		expect(openai.input).not.toContain("video");
		// Non-video modalities survive the filter.
		expect(openai.input).toEqual(["text", "image", "audio"]);
	});

	test("azure-openai-responses does not advertise video (same Responses converter)", () => {
		const azure = byProvider("azure");
		expect(azure.api).toBe("azure-openai-responses");
		expect(azure.input).not.toContain("video");
		expect(azure.input).toEqual(["text", "image", "audio"]);
	});

	test("google-generative-ai still advertises video (converter forwards it)", () => {
		const google = byProvider("google");
		expect(google.api).toBe("google-generative-ai");
		expect(google.input).toContain("video");
		expect(google.input).toEqual(["text", "image", "audio", "video"]);
	});

	test("bedrock-converse-stream drops both audio and video (Converse converter omits both)", () => {
		const bedrock = byProvider("amazon-bedrock");
		expect(bedrock.api).toBe("bedrock-converse-stream");
		// The Converse converter replaces audio and video blocks with
		// [unsupported …] text placeholders, so advertising either would lie.
		expect(bedrock.input).not.toContain("audio");
		expect(bedrock.input).not.toContain("video");
		expect(bedrock.input).toEqual(["text", "image"]);
	});
});
