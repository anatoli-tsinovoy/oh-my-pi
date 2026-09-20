import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env, ptree } from "@oh-my-pi/pi-utils";
import { getEditorCommand, resolveEditorSpawnCommand } from "../../../../utils/external-editor";

/** Open a local working-tree file in a focused tmux pane, never the PR's remote revision. */
export async function openFileInTmux(filePath: string, cwd: string): Promise<void> {
	if (!$env.TMUX?.trim()) throw new Error("Cannot open file: not running inside tmux");
	const resolvedPath = path.resolve(cwd, filePath);
	if (!(await fs.stat(resolvedPath)).isFile()) throw new Error("Cannot open file: not a regular file");
	const editor = getEditorCommand() ?? $env.PAGER?.trim() ?? "less";
	const { cmd } = resolveEditorSpawnCommand(editor, resolvedPath);
	const pane = $env.TMUX_PANE?.trim();
	const result = await ptree.exec(
		["tmux", "split-window", "-P", "-F", "#{pane_id}", "-c", cwd, ...(pane ? ["-t", pane] : []), "--", ...cmd],
		{ cwd, timeout: 10_000, allowNonZero: true, stderr: "full" },
	);
	if (result.exitCode !== 0) throw new Error(`Cannot open file in tmux: ${result.stderr.trim()}`);
}
