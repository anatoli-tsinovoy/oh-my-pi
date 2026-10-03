import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";

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

describe("/fork slash command", () => {
	it("offers pane, window, and tab through shared builtin autocomplete", async () => {
		const provider = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd());
		const suggestions = await provider.getSuggestions(["/fork "], 0, 6);

		expect(suggestions?.items.map(item => item.label)).toEqual(["pane", "window", "tab"]);
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
