import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "./logic.ts";
import { ProjectSkillsOverlay, type UiResult } from "./ui.ts";

async function openPanel(ctx: ExtensionCommandContext): Promise<UiResult | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Use /project-skills in Pi's interactive TUI", "warning");
		return undefined;
	}

	const agentDir = getAgentDir();
	const catalog = await buildCatalog(ctx.cwd, agentDir);
	if (catalog.skills.length === 0) {
		ctx.ui.notify("No skills discovered for this project", "warning");
		return undefined;
	}

	return ctx.ui.custom<UiResult>((tui, theme, keybindings, done) => {
		return new ProjectSkillsOverlay(ctx.cwd, agentDir, catalog, theme, keybindings, tui, done);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			// Near-max viewport with ~2-cell outer inset + framed chrome.
			width: "98%",
			maxHeight: "96%",
			minWidth: 40,
			margin: 2,
			visible: (termWidth, termHeight) => termWidth >= 36 && termHeight >= 12,
		},
	});
}

export default function projectSkillToggle(pi: ExtensionAPI): void {
	pi.registerCommand("project-skills", {
		description: "Exclude or restore global skills for this project only",
		handler: async (_args, ctx) => {
			try {
				const result = await openPanel(ctx);
				if (!result) return;
				ctx.ui.notify(
					`Project skill exclusions: ${result.excludedCount}. Run /reload (or restart) to apply.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
