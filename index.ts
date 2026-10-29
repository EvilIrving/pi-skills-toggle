import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "./logic.ts";
import { ProjectSkillsOverlay, type UiResult } from "./ui.ts";

async function openPanel(ctx: ExtensionCommandContext, initialQuery = ""): Promise<UiResult | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Use /skills in Pi's interactive TUI", "warning");
		return undefined;
	}

	const agentDir = getAgentDir();
	const catalog = await buildCatalog(ctx.cwd, agentDir);
	if (catalog.skills.length === 0) {
		ctx.ui.notify("No skills discovered for this project", "warning");
		return undefined;
	}

	return ctx.ui.custom<UiResult>((tui, theme, keybindings, done) => {
		return new ProjectSkillsOverlay(ctx.cwd, agentDir, catalog, theme, keybindings, tui, done, initialQuery);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "80%",
			maxHeight: "96%",
			minWidth: 40,
			margin: 2,
			visible: (termWidth, termHeight) => termWidth >= 36 && termHeight >= 12,
		},
	});
}

export default function skillToggle(pi: ExtensionAPI): void {
	const handler = async (args: string, ctx: ExtensionCommandContext) => {
		try {
			const result = await openPanel(ctx, typeof args === "string" ? args.trim() : "");
			if (!result) return;
			ctx.ui.notify(
				`Project skill exclusions: ${result.excludedCount}. Run /reload (or restart) to apply.`,
				"info",
			);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	pi.registerCommand("skills", {
		description: "Exclude or restore global skills for this project only",
		handler,
	});
}
