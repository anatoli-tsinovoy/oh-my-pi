import { prompt } from "@oh-my-pi/pi-utils";
import textReviewTemplate from "./prompts/text-review.md" with { type: "text" };
import type { TextReviewAnnotation, TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";

const SHORT_SOURCE_CHARACTER_LIMIT = 1000;

/** Pick a Markdown fence that cannot occur in the supplied exact value. */
export function markdownFenceFor(value: string): string {
	let longestRun = 0;
	let run = 0;
	for (const character of value) {
		if (character === "`") {
			run++;
			if (run > longestRun) longestRun = run;
		} else {
			run = 0;
		}
	}
	return "`".repeat(Math.max(3, longestRun + 1));
}

function shouldIncludeSource(source: TextReviewSource): boolean {
	if (source.kind === "code" || source.kind === "command" || source.kind === "clipboard") return true;
	if (source.provenance?.kind === "latest-assistant") return false;
	return source.text.length <= SHORT_SOURCE_CHARACTER_LIMIT;
}

export function shouldSummarizeTextReviewSource(source: TextReviewSource): boolean {
	return source.provenance?.kind === "session" && !shouldIncludeSource(source);
}

export function normalizeTextReviewContextSummary(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 0 && trimmed.length <= 999 ? trimmed : "";
}

function sanitizePreviewLabel(value: string, maxLength = 96): string {
	const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
	const oneLine = withoutAnsi
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (oneLine.length <= maxLength) return oneLine;
	return `${oneLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

interface RenderedTextAnnotation {
	number: number;
	isLine: boolean;
	quote?: string;
	note: string;
	quoteIsInline?: boolean;
	quoteFence?: string;
}

/** Build one paste-only text feedback prompt; empty annotations produce no prompt. */
export function buildTextReviewPrompt(
	source: TextReviewSource,
	annotations: readonly TextReviewAnnotation[],
	contextSummary?: string,
): string | undefined {
	if (annotations.length === 0) return undefined;
	const renderedAnnotations: RenderedTextAnnotation[] = annotations.map((annotation, index) => {
		if (annotation.scope === "text") {
			return { number: index + 1, isLine: false, note: annotation.note };
		}
		const quoteIsInline = !/[\r\n`]/.test(annotation.quote);
		return {
			number: index + 1,
			isLine: true,
			quote: annotation.quote,
			note: annotation.note,
			quoteIsInline,
			quoteFence: quoteIsInline ? undefined : markdownFenceFor(annotation.quote),
		};
	});
	const summary = shouldSummarizeTextReviewSource(source)
		? normalizeTextReviewContextSummary(contextSummary ?? "")
		: "";
	return prompt.render(textReviewTemplate, {
		sourceLabel:
			source.kind === "message" && source.provenance?.kind === "latest-assistant"
				? "your last reply"
				: sanitizePreviewLabel(source.label) || `${source.kind} source`,
		includeSource: shouldIncludeSource(source) || (shouldSummarizeTextReviewSource(source) && !summary),
		sourceFence: markdownFenceFor(source.text),
		sourceText: source.text,
		contextSummary: summary,
		summaryFence: summary ? markdownFenceFor(summary) : "```",
		annotations: renderedAnnotations,
	});
}
