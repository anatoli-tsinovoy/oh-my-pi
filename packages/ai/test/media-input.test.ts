import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertMessages as convertOpenAIChatMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const audioMessage: Context = {
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "Transcribe this." },
				{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" },
			],
			timestamp: 1,
		},
	],
};

const googleModel = buildModel({
	id: "gemini-audio-test",
	name: "Gemini Audio Test",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: false,
	input: ["text", "audio", "video"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
});

const openAIModel = buildModel({
	id: "gpt-audio-test",
	name: "GPT Audio Test",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "audio"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
});

const anthropicModel = buildModel({
	id: "claude-media-test",
	name: "Claude Media Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "audio", "video"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
});

describe("media message encoding", () => {
	it("encodes supported audio as Gemini inlineData", () => {
		const contents = convertGoogleMessages(googleModel, audioMessage);
		expect(contents).toEqual([
			{
				role: "user",
				parts: [{ text: "Transcribe this." }, { inlineData: { mimeType: "audio/wav", data: "UklGRg==" } }],
			},
		]);
	});

	it("encodes supported audio as OpenAI input_audio", () => {
		const messages = convertOpenAIChatMessages(openAIModel, audioMessage, openAIModel.compat);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Transcribe this." },
					{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
				],
			},
		]);
	});

	it("degrades Anthropic audio to explicit unsupported text", () => {
		const messages = convertAnthropicMessages(audioMessage.messages, anthropicModel, false);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Transcribe this." },
					{ type: "text", text: "[unsupported audio: audio/wav]" },
				],
			},
		]);
	});
});
