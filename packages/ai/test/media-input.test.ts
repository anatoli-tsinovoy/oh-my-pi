import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { convertMessages as convertOpenAIChatMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	appendResponsesToolResultMessages,
	convertResponsesInputContent,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
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

const openAIResponsesModel = buildModel({
	id: "gpt-responses-audio-test",
	name: "GPT Responses Audio Test",
	api: "openai-responses",
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

	it("does not relabel unsupported OpenAI audio as MP3", () => {
		const oggContent = [{ type: "audio" as const, data: "T2dnUw==", mimeType: "audio/ogg" }];
		const ogg: Context = {
			messages: [
				{
					role: "user",
					content: oggContent,
					timestamp: 1,
				},
			],
		};

		const chat = convertOpenAIChatMessages(openAIModel, ogg, openAIModel.compat);
		expect(chat).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "[audio omitted: OpenAI supports only WAV and MP3 input]" }],
			},
		]);
		expect(convertResponsesInputContent(oggContent, false, true, false)).toEqual([
			{ type: "input_text", text: "[audio omitted: OpenAI supports only WAV and MP3 input]" },
		]);
	});

	it("forwards supported audio from Responses tool results", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_audio",
			toolName: "record",
			content: [{ type: "audio", data: "UklGRg==", mimeType: "audio/wav" }],
			isError: false,
			timestamp: 1,
		};
		const messages: Array<Record<string, unknown>> = [];

		appendResponsesToolResultMessages(
			messages as never,
			toolResult,
			openAIResponsesModel,
			false,
			false,
			new Set(["call_audio"]),
		);

		expect(messages).toEqual([
			{ type: "function_call_output", call_id: "call_audio", output: "(see attached media)" },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Attached media from tool result:" },
					{ type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
				],
			},
		]);
	});
});
