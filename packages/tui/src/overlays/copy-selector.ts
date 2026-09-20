/**
 * Fullscreen `/copy` picker over the transcript itself.
 *
 * Replays the current branch with {@link ChatTranscriptBuilder} on the
 * alternate screen and moves the same dotted outline the esc-esc rewind
 * selector uses over the rendered items; Enter copies the outlined turn's
 * text. Right descends into the turn's inner blocks — fenced code, `>`-quotes,
 * bash/eval commands, tool output, and links — replacing the turn's rendered
 * region with a stacked, syntax-highlighted block view whose outline steps per
 * block; Left/Esc ascend back to the transcript. Every block caption carries a
 * clickable `⧉ copy` control and link blocks add `↗ open`; the overlay is
 * fullscreen, so the terminal reports clicks here (SGR mouse) even though the
 * main transcript never captures the mouse. Keyboard: Enter copies, `o` opens.
 * A URL that wrapped across terminal rows therefore needs neither a careful
 * mouse selection nor cmd-click.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, matchesKey, routeSgrMouseInput, type TUI, truncateToWidth, visibleWidth } from "../index";
import type { MessageRenderer } from "../chat/extension-types";
import {
	isUserRequestEntry,
	type TranscriptEntryLike as TranscriptEntry,
	transcriptEntryMessage,
	userTurnDraft,
} from "../chat/transcript-entry";
import type { SessionMessageEntryLike as SessionMessageEntry } from "../chat/transcript-entry";
import { replaceTabs } from "../render/render-utils";
import { highlightCode, type ThemeColor, theme } from "../theme/theme";
import { commandFromToolCall, extractBlocks, extractLinks, type LastCommand, type MessageBlock } from "./copy-targets";
import { matchesAppToolsExpand, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { ChatTranscriptBuilder } from "../chat/chat-transcript-builder";
import { TranscriptBrowser, type TranscriptBrowserFrame } from "../chat/transcript-browser";
import {
	appendOutlineEntries,
	type ComposedColumn,
	composeOutlineColumn,
	type OutlineTarget,
	outlineRows,
} from "../chat/transcript-outline";

/** Metadata for the exact content selected from the transcript picker. */
export interface CopySelection {
	content: string;
	label: string;
	/** The persisted transcript entry that supplied this content. */
	entry: TranscriptEntry;
	/** The exact inner block selected, when the picker is descended into a turn. */
	block?: CopyBlock;
}

export interface CopySelectorDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	/** Whether the active registry entry came from a built-in factory. */
	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	linkTargets?: ReadonlyMap<string, string>;
	requestRender: () => void;
	/** Optional replacement for the Copy overlay title (for source pickers). */
	title?: string;
	/** Optional action label used in controls and hints instead of "copy". */
	actionLabel?: string;
	/** The outlined content was chosen — copy it. `label` feeds the status line. */
	onPick: (content: string, label: string, selection: CopySelection) => void;
	/** `o` on a link block — open `href` with the system opener. Absent: `o` is ignored. */
	onOpen?: (href: string, label: string) => void;
	onCancel: () => void;
}

/** One copyable inner block of a transcript turn. */
export interface CopyBlock {
	/** Short kind label ("code · ts", "bash command", "read result", …). */
	label: string;
	/** Exact text placed on the clipboard. */
	content: string;
	/** Highlight language for the block preview. */
	language?: string;
	/** Set for link blocks: the URL `o` opens. `content` is the same URL. */
	href?: string;
	/** Present only for code/quote blocks extracted from markdown. */
	kind?: MessageBlock["kind"];
	/** Native command metadata for assistant tool-call blocks. */
	command?: LastCommand;
}

interface SourcedCopyBlock {
	entry: TranscriptEntry;
	block: CopyBlock;
}
function blockSelection(source: SourcedCopyBlock): CopySelection {
	return {
		content: source.block.content,
		label: source.block.label,
		entry: source.entry,
		block: source.block,
	};
}

/** Preview rows shown per block in the descended view; copy always takes the full text. */
const BLOCK_PREVIEW_LINES = 12;
/** The copy picker's outline stroke — green, distinct from the rewind selector's accent. */
const OUTLINE_COLOR: ThemeColor = "success";
/**
 * Entries replayed when the picker opens. Replaying a long session's whole
 * branch costs seconds before the first frame (one component built and
 * rendered per entry), and the clipboard target is almost always recent, so
 * the picker starts at this tail and loads the rest on demand (`a`).
 */
const INITIAL_ENTRIES = 600;

/** A clickable control on a block caption, in composed-column columns. */
interface ControlRegion {
	action: "copy" | "open";
	blockIndex: number;
	start: number;
	end: number;
}

export class CopySelectorComponent implements Component {
	#builder: ChatTranscriptBuilder;
	#browser: TranscriptBrowser;
	#targets: OutlineTarget[] = [];
	#selected = 0;
	#visible: boolean[] | undefined;
	#expanded = false;
	/** Inner blocks of the selected turn while descended, else undefined. */
	#blocks: SourcedCopyBlock[] | undefined;
	#blockSelected = 0;
	#blockCache = new Map<string, SourcedCopyBlock[]>();
	/** Click targets of the last render, keyed by composed-column line index. */
	#controls = new Map<number, ControlRegion[]>();

	/** Whole branch; the picker may currently replay only its tail. */
	#entries: TranscriptEntry[];
	/** True while older history is still unreplayed. */
	#truncated = false;

	constructor(
		entries: TranscriptEntry[],
		private readonly deps: CopySelectorDeps,
	) {
		this.#entries = entries;
		const tail = recentEntries(entries, INITIAL_ENTRIES);
		this.#truncated = tail.length < entries.length;
		this.#builder = this.#replay(tail);
		this.#selected = Math.max(0, this.#targets.length - 1);
		this.#browser = new TranscriptBrowser({
			getHeight: () => this.deps.ui.terminal?.rows || process.stdout.rows || 40,
			frame: context => this.#frame(context.contentWidth),
		});
	}

	/** Build a transcript for `entries` and adopt its targets. */
	#replay(entries: TranscriptEntry[]): ChatTranscriptBuilder {
		const builder = new ChatTranscriptBuilder({
			ui: this.deps.ui,
			getTool: this.deps.getTool,
			isBuiltInTool: this.deps.isBuiltInTool,
			getMessageRenderer: this.deps.getMessageRenderer,
			cwd: this.deps.cwd,
			hideThinkingBlock: this.deps.hideThinkingBlock,
			proseOnlyThinking: this.deps.proseOnlyThinking,
			linkTargets: this.deps.linkTargets,
			requestRender: this.deps.requestRender,
		});
		builder.setExpanded(this.#expanded);
		this.#targets = appendOutlineEntries(builder, entries);
		return builder;
	}

	/**
	 * Replay the whole branch, keeping the outline on the same turn. Pays the
	 * full replay cost once, only when the user asks for older history.
	 */
	#loadFullHistory(): void {
		if (!this.#truncated) return;
		const selectedId = this.#targets[this.#selected]?.turnId;
		const previous = this.#builder;
		this.#builder = this.#replay(this.#entries);
		previous.dispose();
		this.#truncated = false;
		this.#visible = undefined;
		const restored = selectedId ? this.#targets.findIndex(target => target.turnId === selectedId) : -1;
		this.#selected = restored >= 0 ? restored : Math.max(0, this.#targets.length - 1);
		this.#blocks = undefined;
		this.#blockSelected = 0;
		this.deps.requestRender();
	}

	/** Number of copyable transcript items; hosts skip mounting when zero. */
	get targetCount(): number {
		return this.#targets.length;
	}

	invalidate(): void {
		this.#builder.container.invalidate();
		this.#browser.invalidate();
	}

	dispose(): void {
		this.#builder.dispose();
	}

	#blocksFor(target: OutlineTarget): SourcedCopyBlock[] {
		const cached = this.#blockCache.get(target.turnId);
		if (cached) return cached;
		const blocks = collectBlocks(target.entries);
		this.#blockCache.set(target.turnId, blocks);
		return blocks;
	}

	// ========================================================================
	// Input
	// ========================================================================

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					if (this.#browser.scroll(event.wheel * 3)) this.deps.requestRender();
					return true;
				}
				if (event.leftClick) this.#click(event.row, event.col);
				return true;
			});
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "escape")) {
			if (this.#blocks) this.#ascend();
			else this.deps.onCancel();
			return;
		}
		if (matchesAppToolsExpand(data)) {
			this.#expanded = !this.#expanded;
			this.#builder.setExpanded(this.#expanded);
			this.deps.requestRender();
			return;
		}
		if (matchesSelectUp(data)) {
			this.#moveVertical(-1);
			return;
		}
		if (matchesSelectDown(data)) {
			this.#moveVertical(1);
			return;
		}
		if (matchesKey(data, "right")) {
			if (this.#blocks) return;
			const target = this.#targets[this.#selected];
			if (!target) return;
			const blocks = this.#blocksFor(target);
			if (blocks.length === 0) return;
			this.#blocks = blocks;
			this.#blockSelected = 0;
			this.deps.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			if (this.#blocks) this.#ascend();
			return;
		}
		if ((data === "a" || data === "A") && !this.#blocks) {
			this.#loadFullHistory();
			return;
		}
		if (data === "o" || data === "O") {
			const source = this.#blocks?.[this.#blockSelected];
			const block = source?.block;
			if (block?.href && this.deps.onOpen) this.deps.onOpen(block.href, block.label);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			if (this.#blocks) {
				const source = this.#blocks[this.#blockSelected];
				if (source) {
					const selection = blockSelection(source);
					this.deps.onPick(selection.content, selection.label, selection);
				}
				return;
			}
			const target = this.#targets[this.#selected];
			if (!target) return;
			const selection = targetCopy(target, this.#blocksFor(target));
			this.deps.onPick(selection.content, selection.label, selection);
			return;
		}
		// Page/home/end/shift+arrow scrolling without moving the selection.
		if (this.#browser.handleScrollKey(data)) this.deps.requestRender();
	}

	#ascend(): void {
		this.#blocks = undefined;
		this.#blockSelected = 0;
		this.deps.requestRender();
	}

	/** A left click at terminal (row, col): act if it lands on a caption control. */
	#click(row: number, col: number): void {
		if (!this.#blocks) return;
		const point = this.#browser.toContentPoint(row, col);
		if (!point) return;
		const line = point.row;
		const regions = this.#controls.get(line);
		if (!regions) return;
		const hit = regions.find(region => point.col >= region.start && point.col < region.end);
		if (!hit) return;
		const source = this.#blocks[hit.blockIndex];
		if (!source) return;
		this.#blockSelected = hit.blockIndex;
		if (hit.action === "open") {
			const block = source.block;
			if (block.href && this.deps.onOpen) this.deps.onOpen(block.href, block.label);
			return;
		}
		const selection = blockSelection(source);
		this.deps.onPick(selection.content, selection.label, selection);
	}

	#moveVertical(delta: -1 | 1): void {
		if (this.#blocks) {
			const next = this.#blockSelected + delta;
			if (next >= 0 && next < this.#blocks.length) {
				this.#blockSelected = next;
				this.deps.requestRender();
			}
			return;
		}
		let index = this.#selected + delta;
		while (index >= 0 && index < this.#targets.length) {
			if (this.#visible?.[index] !== false) {
				this.#selected = index;
				this.deps.requestRender();
				return;
			}
			index += delta;
		}
	}

	// ========================================================================
	// Render
	// ========================================================================

	render(width: number): readonly string[] {
		return this.#browser.render(width);
	}

	#frame(contentWidth: number): TranscriptBrowserFrame {
		const children = this.#builder.container.children;
		const prepared = this.#browser.prepareOutline(children, this.#targets, this.#selected, contentWidth);
		this.#visible = prepared.visible;
		if (prepared.selected !== this.#selected) {
			this.#selected = prepared.selected;
			this.#blocks = undefined;
			this.#blockSelected = 0;
		}

		const target = this.#targets[this.#selected];
		const blocks = target ? this.#blocksFor(target) : [];
		let composed: ComposedColumn;
		this.#controls = new Map();
		if (this.#blocks && target) {
			// Descended: the turn's rendered region is replaced by its block stack.
			const before = composeOutlineColumn(prepared.childRows, 0, target.start, [], -1, contentWidth, undefined);
			const stack = this.#composeBlocks(this.#blocks, contentWidth, before.lines.length);
			const after = composeOutlineColumn(
				prepared.childRows,
				target.end,
				children.length,
				[],
				-1,
				contentWidth,
				undefined,
			);
			composed = {
				lines: [...before.lines, ...stack.lines, ...after.lines],
				selStart: stack.selStart >= 0 ? before.lines.length + stack.selStart : -1,
				selEnd: stack.selEnd >= 0 ? before.lines.length + stack.selEnd : -1,
			};
		} else {
			// The caption on the outline advertises Right's descent into blocks.
			composed = this.#browser.composeOutline({
				children,
				targets: this.#targets,
				selected: this.#selected,
				columnWidth: contentWidth,
				prepared,
				style: {
					color: OUTLINE_COLOR,
					caption: blocks.length > 0 ? `${blocks.length} block${blocks.length === 1 ? "" : "s"} →` : undefined,
				},
			}).column;
		}

		const selectedBlock = this.#blocks?.[this.#blockSelected]?.block;
		const actionLabel = this.deps.actionLabel ?? "copy";
		const openHint = selectedBlock?.href && this.deps.onOpen ? "  o open" : "";
		const hint = this.#blocks
			? `${this.#blockSelected + 1}/${this.#blocks.length}  ↑/↓ block  ←/esc back  enter ${actionLabel}${openHint}  click ${theme.cmd.copy}/${theme.cmd.share}`
			: `${this.#targets.length > 0 ? `${this.#selected + 1}/${this.#targets.length}  ` : ""}↑/↓ step  ${blocks.length > 0 ? "→ blocks  " : ""}enter ${actionLabel}  ${this.#truncated ? "a earlier turns  " : ""}ctrl+o expand  esc close`;
		const anchorId = target
			? this.#blocks
				? `copy:${target.turnId}:block:${this.#blockSelected}`
				: `copy:${target.turnId}`
			: undefined;
		const heading = this.deps.title ? theme.bold(this.deps.title) : `${theme.cmd.copy} ${theme.bold("Copy")}`;
		const description = this.deps.title
			? theme.fg("dim", "pick a transcript source")
			: theme.fg("dim", "pick what to put on the clipboard");
		return {
			header: [`${heading}${theme.sep.dot}${description}`],
			body: {
				lines: composed.lines,
				anchor:
					anchorId !== undefined && composed.selStart >= 0
						? { id: anchorId, start: composed.selStart, end: composed.selEnd }
						: undefined,
			},
			footer: [theme.fg("dim", hint)],
		};
	}

	/**
	 * The selected turn exploded into captioned block previews, selected one
	 * outlined. Each caption ends with clickable controls; their column spans
	 * are recorded in `#controls` under the composed line index
	 * (`lineOffset` + local index) so {@link #click} can resolve a mouse hit.
	 */
	#composeBlocks(blocks: SourcedCopyBlock[], columnWidth: number, lineOffset: number): ComposedColumn {
		const inner = Math.max(10, columnWidth - 4);
		const lines: string[] = [];
		let selStart = -1;
		let selEnd = -1;
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index]!.block;
			const raw = block.content.split("\n");
			const shown = raw.slice(0, BLOCK_PREVIEW_LINES);
			const styled = block.language ? highlightCode(shown.join("\n"), block.language) : shown;
			const rows = styled.map(row => truncateToWidth(replaceTabs(row), inner));
			if (raw.length > shown.length) {
				rows.push(theme.fg("dim", `… +${raw.length - shown.length} more lines`));
			}
			const selected = index === this.#blockSelected;
			const captionColor: ThemeColor = selected ? OUTLINE_COLOR : "dim";
			const controls: Array<{ action: ControlRegion["action"]; text: string }> = [
				{ action: "copy", text: `${theme.cmd.copy} ${this.deps.actionLabel ?? "copy"}` },
			];
			if (block.href && this.deps.onOpen) controls.push({ action: "open", text: `${theme.cmd.share} open` });
			const controlsWidth = controls.reduce((sum, control) => sum + visibleWidth(control.text) + 2, 0);
			const summary = truncateToWidth(
				`${index + 1}/${blocks.length}${theme.sep.dot}${block.label}${theme.sep.dot}${raw.length} line${raw.length === 1 ? "" : "s"}`,
				Math.max(4, inner - controlsWidth),
			);
			// Caption: two-space gutter, summary, then the controls, each preceded by two spaces.
			let caption = theme.fg(captionColor, summary);
			let cursor = 2 + visibleWidth(summary);
			const regions: ControlRegion[] = [];
			for (const control of controls) {
				cursor += 2;
				regions.push({
					action: control.action,
					blockIndex: index,
					start: cursor,
					end: cursor + visibleWidth(control.text),
				});
				caption += `  ${theme.fg("accent", control.text)}`;
				cursor += visibleWidth(control.text);
			}
			lines.push("");
			this.#controls.set(lineOffset + lines.length, regions);
			if (selected) {
				selStart = lines.length;
				lines.push(`  ${caption}`);
				lines.push(...outlineRows(rows, inner, { color: OUTLINE_COLOR }));
				selEnd = lines.length;
			} else {
				lines.push(`  ${caption}`);
				for (const row of rows) lines.push(row ? `  ${row}` : row);
			}
		}
		lines.push("");
		return { lines, selStart, selEnd };
	}
}

/**
 * The trailing slice starting at the last turn initiator at or before
 * `entries.length - limit`: a user message, or a custom message that starts
 * a user-attributed turn (a directly invoked `/skill:` prompt, a collab peer's
 * prompt), the same boundary `ChatTranscriptBuilder` uses.
 *
 * The cut has to land on a turn boundary: the builder drops a tool result
 * whose initiating call was sliced away, so a tail beginning mid-turn renders
 * without its command — and a tail of nothing but orphaned results would
 * leave the picker with no target at all. Scanning backwards keeps the whole
 * final turn instead, and a branch whose last turn is itself longer than
 * `limit` replays in full.
 */
function recentEntries(entries: TranscriptEntry[], limit: number): TranscriptEntry[] {
	if (entries.length <= limit) return entries;
	for (let index = entries.length - limit; index > 0; index--) {
		if (isUserRequestEntry(entries[index]!)) return entries.slice(index);
	}
	return entries;
}

/** Raw multi-line text of a user message (string or text blocks). */
function rawUserText(message: Extract<SessionMessageEntry["message"], { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

/** Concatenated visible text blocks of an assistant message. */
function assistantVisibleText(message: Extract<SessionMessageEntry["message"], { role: "assistant" }>): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim();
}

/** Joined text content of a tool result. */
function toolResultText(message: Extract<SessionMessageEntry["message"], { role: "toolResult" }>): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n")
		.trim();
}

function pushMarkdownBlocks(blocks: SourcedCopyBlock[], text: string, entry: TranscriptEntry): void {
	for (const block of extractBlocks(text)) {
		const copyBlock: CopyBlock =
			block.kind === "code"
				? {
						label: block.lang ? `${block.lang} code` : "code",
						content: block.code,
						language: block.lang || undefined,
						kind: block.kind,
					}
				: { label: "quote", content: block.text, kind: block.kind };
		blocks.push({ entry, block: copyBlock });
	}
	// Links follow the message's blocks. The preview shows the whole URL on one
	// row, so a link the transcript wrapped is copied or opened intact.
	for (const link of extractLinks(text)) {
		blocks.push({
			entry,
			block: {
				label: link.text !== link.href ? `link${theme.sep.dot}${link.text}` : "link",
				content: link.href,
				href: link.href,
			},
		});
	}
}

/** Inner blocks of one turn: markdown code/quotes, commands, and tool output. */
function collectBlocks(entries: readonly TranscriptEntry[]): SourcedCopyBlock[] {
	const blocks: SourcedCopyBlock[] = [];
	for (const entry of entries) {
		const message = transcriptEntryMessage(entry);
		if (!message) continue;
		switch (message.role) {
			case "user":
				pushMarkdownBlocks(blocks, rawUserText(message), entry);
				break;
			case "assistant": {
				pushMarkdownBlocks(blocks, assistantVisibleText(message), entry);
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const command = commandFromToolCall(content);
					if (command) {
						blocks.push({
							entry,
							block: {
								label: command.kind === "bash" ? "bash command" : "eval code",
								content: command.code,
								language: command.language,
								command,
							},
						});
					}
				}
				break;
			}
			case "toolResult": {
				const text = toolResultText(message);
				if (text)
					blocks.push({
						entry,
						block: {
							label: `${message.toolName} result`,
							content: text,
						},
					});
				break;
			}
			case "bashExecution":
				blocks.push({
					entry,
					block: {
						label: "command",
						content: message.command,
						language: "bash",
					},
				});
				if (message.output.trim()) blocks.push({ entry, block: { label: "output", content: message.output } });
				break;
			case "pythonExecution":
				blocks.push({
					entry,
					block: {
						label: "eval code",
						content: message.code,
						language: "python",
					},
				});
				if (message.output.trim()) blocks.push({ entry, block: { label: "output", content: message.output } });
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** Clipboard payload for a whole turn, falling back to its blocks when the turn has no prose. */
function targetCopy(target: OutlineTarget, blocks: readonly SourcedCopyBlock[]): CopySelection {
	const entry = target.entries[0]!;
	const message = transcriptEntryMessage(entry);
	switch (message?.role) {
		case "user":
			return { content: rawUserText(message), label: "user message", entry };
		case "assistant": {
			const text = assistantVisibleText(message);
			if (text) return { content: text, label: "assistant message", entry };
			break;
		}
		case "toolResult": {
			const text = toolResultText(message);
			if (text) return { content: text, label: `${message.toolName} result`, entry };
			break;
		}
		case "bashExecution":
			return {
				content: [message.command, message.output].filter(part => part.trim()).join("\n"),
				label: "bash execution",
				entry,
			};
		case "pythonExecution":
			return {
				content: [message.code, message.output].filter(part => part.trim()).join("\n"),
				label: "eval execution",
				entry,
			};
		case "compactionSummary":
		case "branchSummary":
			return { content: message.summary, label: "summary", entry };
		case "custom":
		case "hookMessage": {
			// A user-invoked skill/collab prompt copies as what the user typed, not the expanded body.
			const draft = message.role === "custom" ? userTurnDraft(entry) : undefined;
			if (draft?.trim()) return { content: draft, label: "user message", entry };
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map(block => block.text)
							.join("\n");
			if (content.trim()) return { content, label: "message", entry };
			break;
		}
		default:
			break;
	}
	// No direct prose (e.g. a pure tool turn): fall back to its blocks joined.
	return {
		content: blocks.map(source => source.block.content).join("\n\n"),
		label: "turn content",
		entry,
	};
}
