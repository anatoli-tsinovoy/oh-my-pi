import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandContext,
} from "../../../../extensibility/custom-commands/types";
import type {
	CodeReviewOverlayResult,
	LocalReviewKind,
	ResolvedReviewTarget,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import {
	extractReviewPrRefFromArgs,
	resolvePrReviewTarget,
	ReviewCommand,
	selectReviewChoice,
	type ReviewPrRef,
} from "../review";
import { buildReviewPrompt, formatCodeReviewAnnotations } from "../review/prompt";
import { getReviewTargetIssue, resolveLocalReviewTarget, type ReviewTargetUI } from "../review/target";
import { acquireClipboardText } from "./clipboard";
import { showCodeReviewOverlay, showTextReviewOverlay } from "./fullscreen";
import {
	createClipboardTextReviewSource,
	selectAnnotationSourceKind,
	selectSessionTextReviewSource,
	type AnnotationSourceKind,
} from "./text-source";
import {
	buildTextReviewPrompt,
	normalizeTextReviewContextSummary,
	shouldSummarizeTextReviewSource,
} from "./text-review";
import { generateTextReviewContextSummary } from "./text-summary";

const ANNOTATE_USAGE = "Usage: /annotate [code-review [focus]|last|session|clipboard]";

interface CodeReviewDependencies {
	resolveLocalReviewTarget(
		kind: LocalReviewKind,
		cwd: string,
		ui: ReviewTargetUI,
	): Promise<ResolvedReviewTarget | undefined>;
	resolvePrReviewTarget(
		api: CustomCommandAPI,
		ctx: CustomCommandContext,
		ref: ReviewPrRef,
	): Promise<ResolvedReviewTarget | undefined>;
	showCodeReviewOverlay(
		ctx: CustomCommandContext,
		target: ResolvedReviewTarget,
	): Promise<CodeReviewOverlayResult | undefined>;
}

interface TextAnnotationDependencies {
	selectAnnotationSourceKind: typeof selectAnnotationSourceKind;
	selectSessionTextReviewSource: typeof selectSessionTextReviewSource;
	acquireClipboardText: typeof acquireClipboardText;
	showTextReviewOverlay: typeof showTextReviewOverlay;
	generateTextReviewContextSummary: typeof generateTextReviewContextSummary;
}

const defaultCodeReviewDependencies: CodeReviewDependencies = {
	resolveLocalReviewTarget,
	resolvePrReviewTarget,
	showCodeReviewOverlay,
};

const defaultTextAnnotationDependencies: TextAnnotationDependencies = {
	selectAnnotationSourceKind,
	selectSessionTextReviewSource,
	acquireClipboardText,
	showTextReviewOverlay,
	generateTextReviewContextSummary,
};

function parseCodeReviewFocus(args: string): string | undefined {
	const match = args.trim().match(/^code-review(?:\s+([\s\S]*))?$/);
	return match ? (match[1]?.trim() ?? "") : undefined;
}

function parseAnnotationSourceKind(args: string): AnnotationSourceKind | undefined {
	const trimmed = args.trim();
	if (trimmed === "last" || trimmed === "session" || trimmed === "clipboard") return trimmed;
	return undefined;
}

function splitReviewArgs(args: string): string[] {
	return args.trim() ? args.trim().split(/\s+/) : [];
}

async function finishCodeReview(
	ctx: CustomCommandContext,
	target: ResolvedReviewTarget,
	focus: string | undefined,
	showOverlay: CodeReviewDependencies["showCodeReviewOverlay"],
): Promise<string | undefined> {
	const issue = getReviewTargetIssue(target);
	if (issue) {
		ctx.ui.notify(issue, "warning");
		return undefined;
	}
	const result = await showOverlay(ctx, target);
	if (!result) return undefined;
	if (result.action === "paste") {
		const annotations = formatCodeReviewAnnotations(result.annotations, { forReviewer: false });
		if (annotations) ctx.ui.pasteToEditor(annotations);
		return undefined;
	}
	const annotations = formatCodeReviewAnnotations(result.annotations, {
		forReviewer: true,
		supplementalInstructions: focus,
	});
	return buildReviewPrompt(target, annotations);
}

/** Run `/annotate code-review`, freezing one target before the overlay opens. */
export async function runCodeReviewCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<CodeReviewDependencies> = {},
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		return new ReviewCommand(api).execute(splitReviewArgs(args), ctx);
	}
	const resolved = { ...defaultCodeReviewDependencies, ...dependencies };
	const parsed = extractReviewPrRefFromArgs(splitReviewArgs(args));
	if (parsed.prRef) {
		const target = await resolved.resolvePrReviewTarget(api, ctx, parsed.prRef);
		return target
			? finishCodeReview(ctx, target, parsed.extraInstructions || undefined, resolved.showCodeReviewOverlay)
			: undefined;
	}
	const focus = parsed.extraInstructions || undefined;
	const selectedChoice = await selectReviewChoice(ctx, { includeCustom: false });
	if (!selectedChoice) return undefined;
	if (selectedChoice.kind === "pr") {
		const target = await resolved.resolvePrReviewTarget(api, ctx, selectedChoice.ref);
		return target ? finishCodeReview(ctx, target, focus, resolved.showCodeReviewOverlay) : undefined;
	}
	if (selectedChoice.kind === "custom") return undefined;
	const target = await resolved.resolveLocalReviewTarget(selectedChoice.kind, api.cwd, ctx.ui);
	return target ? finishCodeReview(ctx, target, focus, resolved.showCodeReviewOverlay) : undefined;
}

/** Run `/annotate` text sources; all resulting feedback is pasted, never submitted. */
export async function runAnnotateCommand(
	api: CustomCommandAPI,
	args: string,
	ctx: CustomCommandContext,
	dependencies: Partial<TextAnnotationDependencies & CodeReviewDependencies> = {},
): Promise<string | undefined> {
	const codeReviewFocus = parseCodeReviewFocus(args);
	if (codeReviewFocus !== undefined) {
		return runCodeReviewCommand(api, codeReviewFocus, ctx, dependencies);
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"Text annotation requires the interactive UI. Re-run /annotate from an interactive session; no message was sent.",
			"error",
		);
		return undefined;
	}
	const textDependencies = { ...defaultTextAnnotationDependencies, ...dependencies };
	const trimmed = args.trim();
	let kind: AnnotationSourceKind | undefined;
	if (trimmed.length === 0) kind = await textDependencies.selectAnnotationSourceKind(ctx.ui);
	else {
		kind = parseAnnotationSourceKind(trimmed);
		if (!kind) {
			ctx.ui.notify(ANNOTATE_USAGE, "error");
			return undefined;
		}
	}
	if (!kind) return undefined;
	let source: TextReviewSource | undefined;
	switch (kind) {
		case "code-review":
			return runCodeReviewCommand(api, "", ctx, dependencies);
		case "last":
			source = await textDependencies.selectSessionTextReviewSource(ctx, { autoSelect: "latest-assistant" });
			break;
		case "session":
			source = await textDependencies.selectSessionTextReviewSource(ctx);
			break;
		case "clipboard": {
			const text = await textDependencies.acquireClipboardText(ctx);
			if (text !== undefined) source = createClipboardTextReviewSource(ctx, text);
			break;
		}
	}
	if (!source) return undefined;
	const result = await textDependencies.showTextReviewOverlay(ctx, source);
	if (!result || result.annotations.length === 0) return undefined;
	let contextSummary: string | undefined;
	if (shouldSummarizeTextReviewSource(source)) {
		ctx.ui.setStatus("annotate-summary", "Rephrasing annotation source with the session model…");
		try {
			const generated = await textDependencies.generateTextReviewContextSummary(ctx, source.text);
			contextSummary =
				typeof generated === "string" ? normalizeTextReviewContextSummary(generated) || undefined : undefined;
			if (!contextSummary) {
				ctx.ui.notify(
					"Source summary unavailable; including the full source verbatim beyond the normal 999-character context limit.",
					"warning",
				);
			}
		} catch {
			ctx.ui.notify(
				"Source summary failed; including the full source verbatim beyond the normal 999-character context limit.",
				"warning",
			);
		} finally {
			ctx.ui.setStatus("annotate-summary", undefined);
		}
	}
	const prompt = buildTextReviewPrompt(source, result.annotations, contextSummary);
	if (prompt) ctx.ui.pasteToEditor(prompt);
	return undefined;
}

export class AnnotateCommand implements CustomCommand {
	name = "annotate";
	description = "Annotate a diff or text from the latest reply, session, or clipboard";

	constructor(private readonly api: CustomCommandAPI) {}

	execute(args: string[], ctx: CustomCommandContext): Promise<string | undefined> {
		return runAnnotateCommand(this.api, args.join(" "), ctx);
	}
}

export default AnnotateCommand;
