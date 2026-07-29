import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	BUILTIN_MEDIA_POLICIES,
	findSupportedMediaForm,
	resolveModelRoute,
} from "@oh-my-pi/pi-catalog/media-capabilities";
import type { InputModality, KnownApi, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const APIS = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"gitlab-duo-agent",
	"devin-agent",
] as const satisfies readonly KnownApi[];

type Expected = readonly [user: readonly InputModality[], tools: readonly InputModality[]];
const EXPECTED: Record<KnownApi, Expected> = {
	"openai-completions": [
		["text", "image", "audio"],
		["text", "image"],
	],
	"openai-responses": [
		["text", "image", "audio"],
		["text", "image"],
	],
	openrouter: [
		["text", "image", "audio"],
		["text", "image"],
	],
	"openai-codex-responses": [
		["text", "image"],
		["text", "image"],
	],
	"azure-openai-responses": [
		["text", "image", "audio"],
		["text", "image"],
	],
	"anthropic-messages": [
		["text", "image"],
		["text", "image"],
	],
	"bedrock-converse-stream": [
		["text", "image"],
		["text", "image"],
	],
	"google-generative-ai": [
		["text", "image", "audio", "video"],
		["text", "image"],
	],
	"google-gemini-cli": [
		["text", "image"],
		["text", "image"],
	],
	"google-vertex": [
		["text", "image", "audio", "video"],
		["text", "image"],
	],
	"ollama-chat": [
		["text", "image"],
		["text", "image"],
	],
	"cursor-agent": [
		["text", "image"],
		["text", "image"],
	],
	"gitlab-duo-agent": [
		["text", "image"],
		["text", "image"],
	],
	"devin-agent": [
		["text", "image"],
		["text", "image"],
	],
};

function model(api: KnownApi, extra: Partial<ModelSpec> = {}) {
	return buildModel({
		id: `${api}-model`,
		name: api,
		api,
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text", "image", "audio", "video"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		...extra,
	} as ModelSpec);
}

describe("route-resolved media capability policy", () => {
	test("is exhaustive for all 14 current KnownApi values and preserves vendor evidence", () => {
		expect(Object.keys(BUILTIN_MEDIA_POLICIES).sort()).toEqual([...APIS].sort());
		for (const api of APIS) {
			const built = model(api);
			expect(built.vendorInput, api).toEqual(["text", "image", "audio", "video"]);
			expect(built.input, `${api} user`).toEqual([...EXPECTED[api][0]]);
			expect(built.toolResultInput ?? [], `${api} tools`).toEqual([...EXPECTED[api][1]]);
		}
	});

	test("metadata never enables a missing encoder", () => {
		for (const api of [
			"openai-codex-responses",
			"google-gemini-cli",
			"anthropic-messages",
			"bedrock-converse-stream",
		] as const) {
			const built = model(api);
			expect(built.vendorInput).toContain("video");
			expect(built.input).not.toContain("video");
		}
	});

	test("MIME gates distinguish OpenAI aliases from unsupported Ogg", () => {
		const forms = resolveModelRoute(model("openai-responses")).userMediaForms;
		expect(findSupportedMediaForm(forms, "audio", "audio/x-wav")?.normalizedFormat).toBe("wav");
		expect(findSupportedMediaForm(forms, "audio", "audio/mpeg")?.normalizedFormat).toBe("mp3");
		expect(findSupportedMediaForm(forms, "audio", "audio/ogg")).toBeUndefined();
	});

	test("selected collapsed member evidence changes effective support without a family union", () => {
		const routed = model("openai-responses", {
			id: "family",
			requestModelId: "family-off",
			reasoning: true,
			vendorInput: ["text", "audio"],
			vendorInputByWireModel: {
				"family-off": ["text", "audio"],
				"family-high": ["text"],
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.High],
				effortRouting: { [Effort.High]: "family-high" },
			},
		});
		expect(resolveModelRoute(routed).input).toContain("audio");
		expect(resolveModelRoute(routed, Effort.High).input).toEqual(["text"]);
	});
});
