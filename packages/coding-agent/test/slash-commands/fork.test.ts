import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";

function createRuntime() {
	const handleForkCommand = vi.fn(async (_placement?: "pane" | "window") => undefined);
	const setText = vi.fn();
	const showError = vi.fn();
	const runtime = {
		ctx: {
			handleForkCommand,
			editor: { setText },
			showError,
		} as unknown as InteractiveModeContext,
	} as BuiltinSlashCommandRuntime;
	return { handleForkCommand, setText, showError, runtime };
}

function createForkEditor(): Editor {
	const editor = new Editor({
		...getEditorTheme(),
		hintStyle: text => `\x1b[2m${text}\x1b[0m`,
	});
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd()));
	return editor;
}

async function untilRendered(editor: Editor, predicate: (frame: string) => boolean): Promise<string> {
	while (true) {
		const frame = editor.render(80).join("\n");
		if (predicate(frame)) return frame;
		const { promise, resolve } = Promise.withResolvers<void>();
		const previous = editor.onAutocompleteUpdate;
		editor.onAutocompleteUpdate = () => {
			editor.onAutocompleteUpdate = previous;
			previous?.();
			resolve();
		};
		await promise;
	}
}

describe("/fork slash command", () => {
	it("renders the pane suggestion as a dim hint and accepts it with Tab", async () => {
		const editor = createForkEditor();
		for (const character of "/fork ") editor.handleInput(character);

		const frame = await untilRendered(
			editor,
			value =>
				value.includes("\x1b[2mpane\x1b[0m") &&
				value.includes("pane") &&
				value.includes("window") &&
				value.includes("tab"),
		);
		expect(frame).toContain("\x1b[2mpane\x1b[0m");
		expect(editor.getText()).toBe("/fork ");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork pane ");
	});

	it("renders the remaining window suffix for a partial prefix and accepts it with Tab", async () => {
		const editor = createForkEditor();
		for (const character of "/fork w") editor.handleInput(character);

		const frame = await untilRendered(
			editor,
			value => editor.isShowingAutocomplete() && value.includes("\x1b[2mindow\x1b[0m"),
		);
		expect(frame).toContain("\x1b[2mindow\x1b[0m");
		expect(editor.getText()).toBe("/fork w");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork window ");
	});

	it("keeps bare /fork on the in-process fork path", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/fork", harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).toHaveBeenCalledWith();
	});

	it.each([
		["pane", "pane"],
		["window", "window"],
		["tab", "window"],
	] as const)("routes /fork %s to %s placement", async (argument, expectedPlacement) => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand(`/fork ${argument}`, harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).toHaveBeenCalledWith(expectedPlacement);
	});

	it("consumes invalid placement without submitting it as a prompt", async () => {
		const harness = createRuntime();
		expect(await executeBuiltinSlashCommand("/fork pane extra", harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledWith("Usage: /fork [pane|window|tab]");
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
