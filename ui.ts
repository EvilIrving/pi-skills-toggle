import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	truncateToWidth,
	visibleWidth,
	type Component,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	type Catalog,
	type FilterScope,
	type ListedSkill,
	buildCatalog,
	filterSkills,
	groupSkills,
	nextFilter,
	setExcluded,
} from "./logic.ts";

export type UiResult = { action: "close"; excludedCount: number };

type FlatRow =
	| { kind: "header"; title: string }
	| { kind: "skill"; skill: ListedSkill };

function filterLabel(scope: FilterScope): string {
	switch (scope) {
		case "all":
			return "All";
		case "global":
			return "Global";
		case "project":
			return "Project";
	}
}

function padBetween(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

/** Must stay aligned with overlayOptions in index.ts. */
export const OVERLAY_LAYOUT = {
	margin: 2,
	maxHeightPercent: 0.96,
	boxPaddingY: 2,
	borderLines: 2,
} as const;

/** Fixed panel chrome: title, search, status, blank, blank, footer. */
export const PANEL_CHROME_LINES = 6;

/**
 * Target painted height for the inner panel so Box+borders approach overlay maxHeight.
 * Mirrors Pi TUI resolveOverlayLayout: floor(rows * 96%) then clamp to rows - margin*2.
 */
export function computePanelTargetHeight(termRows: number): number {
	const rows = Math.max(1, Math.floor(termRows));
	const avail = Math.max(1, rows - OVERLAY_LAYOUT.margin * 2);
	const overlayMax = Math.max(1, Math.min(Math.floor(rows * OVERLAY_LAYOUT.maxHeightPercent), avail));
	const chrome = OVERLAY_LAYOUT.boxPaddingY * 2 + OVERLAY_LAYOUT.borderLines;
	return Math.max(PANEL_CHROME_LINES + 4, overlayMax - chrome);
}

/** Content list/search panel (no chrome). */
export class ProjectSkillsPanel implements Component {
	private catalog: Catalog;
	private query = "";
	private searching = false;
	private filter: FilterScope = "all";
	private selected = 0;
	private expanded = new Set<string>();
	private status = "";
	private statusIsError = false;
	private flat: FlatRow[] = [];
	private cachedWidth: number | undefined;
	private cachedRows: number | undefined;
	private cachedLines: string[] | undefined;
	private readonly projectDir: string;
	private readonly agentDir: string;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly tui: TUI;
	private readonly done: (result: UiResult) => void;

	constructor(
		projectDir: string,
		agentDir: string,
		catalog: Catalog,
		theme: Theme,
		keybindings: KeybindingsManager,
		tui: TUI,
		done: (result: UiResult) => void,
	) {
		this.projectDir = projectDir;
		this.agentDir = agentDir;
		this.catalog = catalog;
		this.theme = theme;
		this.keybindings = keybindings;
		this.tui = tui;
		this.done = done;
		this.rebuildFlat();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
	}

	private termRows(): number {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && rows > 0 ? rows : 24;
	}

	rebuildFlat(preferName?: string): void {
		const keepName = preferName ?? this.currentSkill()?.name;
		const filtered = filterSkills(this.catalog.skills, this.query, this.filter);
		const groups = groupSkills(filtered);
		this.flat = [];
		for (const group of groups) {
			this.flat.push({ kind: "header", title: group.title });
			for (const skill of group.items) this.flat.push({ kind: "skill", skill });
		}
		if (keepName) {
			const idx = this.flat.findIndex((row) => row.kind === "skill" && row.skill.name === keepName);
			if (idx >= 0) this.selected = idx;
			else if (this.selected >= this.flat.length) this.selected = Math.max(0, this.flat.length - 1);
		} else if (this.selected >= this.flat.length) {
			this.selected = Math.max(0, this.flat.length - 1);
		}
		this.ensureSkillSelected();
		this.invalidate();
	}

	private ensureSkillSelected(): void {
		if (this.flat.length === 0) return;
		if (this.flat[this.selected]?.kind === "skill") return;
		for (let i = this.selected; i < this.flat.length; i++) {
			if (this.flat[i]?.kind === "skill") {
				this.selected = i;
				return;
			}
		}
		for (let i = this.selected; i >= 0; i--) {
			if (this.flat[i]?.kind === "skill") {
				this.selected = i;
				return;
			}
		}
	}

	private currentSkill(): ListedSkill | undefined {
		const row = this.flat[this.selected];
		return row?.kind === "skill" ? row.skill : undefined;
	}

	private move(delta: number): void {
		if (this.flat.length === 0) return;
		let idx = this.selected;
		for (let n = 0; n < this.flat.length; n++) {
			idx = (idx + delta + this.flat.length) % this.flat.length;
			if (this.flat[idx]?.kind === "skill") {
				this.selected = idx;
				return;
			}
		}
	}

	private async reload(message = "Reloaded"): Promise<void> {
		this.catalog = await buildCatalog(this.projectDir, this.agentDir);
		this.status = message;
		this.statusIsError = false;
		this.rebuildFlat();
	}

	private toggleCurrent(): void {
		const skill = this.currentSkill();
		if (!skill) return;
		if (!skill.toggleable) {
			this.status = skill.ownedByProject
				? "Project skill owns this name — not a global exclusion target"
				: "This skill cannot be toggled";
			this.statusIsError = true;
			this.invalidate();
			return;
		}
		try {
			const next = !skill.excluded;
			const result = setExcluded(this.projectDir, skill.name, next);
			skill.excluded = next;
			this.catalog.excludedCount = this.catalog.skills.filter((s) => s.excluded).length;
			if (result.message) {
				this.status = `${result.message} · run /reload`;
			} else {
				this.status = next
					? `Excluded ${skill.name} · run /reload`
					: `Restored ${skill.name} · run /reload`;
			}
			this.statusIsError = false;
			this.rebuildFlat(skill.name);
		} catch (error) {
			this.status = error instanceof Error ? error.message : String(error);
			this.statusIsError = true;
			this.invalidate();
		}
	}

	handleInput(data: string): void {
		if (this.searching) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				if (this.query) {
					this.query = "";
					this.rebuildFlat();
				} else {
					this.searching = false;
					this.invalidate();
				}
				this.tui.requestRender();
				return;
			}
			if (data === "\u007f" || data === "\b") {
				this.query = this.query.slice(0, -1);
				this.rebuildFlat();
				this.tui.requestRender();
				return;
			}
			if (data === "\r" || data === "\n") {
				this.searching = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (data.length === 1 && data >= " ") {
				this.query += data;
				this.rebuildFlat();
				this.tui.requestRender();
			}
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ action: "close", excludedCount: this.catalog.excludedCount });
			return;
		}
		if (data === "/") {
			this.searching = true;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "f" || data === "F") {
			this.filter = nextFilter(this.filter);
			this.status = `Filter: ${filterLabel(this.filter)}`;
			this.statusIsError = false;
			this.rebuildFlat();
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			void (async () => {
				try {
					await this.reload();
				} catch (error) {
					this.status = `Reload failed: ${error instanceof Error ? error.message : String(error)}`;
					this.statusIsError = true;
					this.invalidate();
				}
				this.tui.requestRender();
			})();
			return;
		}
		if (data === " ") {
			this.toggleCurrent();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const skill = this.currentSkill();
			if (!skill) return;
			if (this.expanded.has(skill.name)) this.expanded.delete(skill.name);
			else this.expanded.add(skill.name);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const termRows = this.termRows();
		if (this.cachedLines && this.cachedWidth === width && this.cachedRows === termRows) {
			return this.cachedLines;
		}
		const theme = this.theme;
		const header: string[] = [];

		const title = theme.fg("accent", theme.bold("Project Skills"));
		const stats = theme.fg(
			"muted",
			`${this.catalog.excludedCount} excluded · ${this.catalog.toggleableCount} toggleable`,
		);
		header.push(truncateToWidth(padBetween(title, stats, width), width));

		const searchText = this.searching
			? `/${this.query}█`
			: this.query
				? `/${this.query}`
				: "/ to search";
		const filterText = theme.fg("muted", filterLabel(this.filter));
		header.push(
			truncateToWidth(
				padBetween(theme.fg(this.searching ? "accent" : "muted", searchText), filterText, width),
				width,
			),
		);

		if (this.status) {
			header.push(truncateToWidth(theme.fg(this.statusIsError ? "error" : "success", this.status), width));
		} else {
			header.push(
				truncateToWidth(theme.fg("dim", "Project-local stubs · does not edit global skills"), width),
			);
		}

		header.push("");

		const hint = (key: string, label: string) => `${theme.fg("accent", key)} ${label}`;
		const current = this.currentSkill();
		const spaceLabel = !current?.toggleable ? "toggle" : current.excluded ? "enable" : "disable";
		const hints = [
			hint("space", spaceLabel),
			hint("f", "filter"),
			hint("/", "search"),
			hint("r", "reload"),
			hint("enter", "details"),
			hint("esc", "close"),
		].join(theme.fg("muted", " | "));
		const footer = truncateToWidth(theme.fg("muted", hints), width);

		// Fill the panel to the overlay's real content budget so Box bg and footer reach bottom.
		const targetHeight = computePanelTargetHeight(termRows);
		const bodyBudget = Math.max(1, targetHeight - PANEL_CHROME_LINES);

		const body: string[] = [];
		let start = 0;
		if (this.selected >= 0) {
			const approx = Math.max(0, this.selected - Math.floor(bodyBudget / 2));
			start = Math.min(approx, Math.max(0, this.flat.length - bodyBudget));
		}

		let rendered = 0;
		for (let i = start; i < this.flat.length && rendered < bodyBudget; i++) {
			const row = this.flat[i]!;
			if (row.kind === "header") {
				body.push(truncateToWidth(theme.fg("muted", row.title), width));
				rendered++;
				continue;
			}

			const skill = row.skill;
			const selected = i === this.selected;
			const chevron = this.expanded.has(skill.name) ? "▾" : "▸";
			const name = skill.excluded ? theme.fg("muted", skill.name) : skill.name;
			const disabledTag = skill.excluded ? theme.fg("error", " [disabled]") : "";
			const lock = !skill.toggleable && skill.ownedByProject ? theme.fg("dim", " · project") : "";
			const left = `${selected ? theme.fg("accent", "›") : " "} ${theme.fg("dim", chevron)} ${name}${disabledTag}${lock}`;
			const right = theme.fg("muted", `(${skill.scopeLabel})`);
			let line = padBetween(left, right, width);
			if (selected) {
				// Prefer accent/bold over selectedBg so Box's opaque panel bg stays consistent.
				line = theme.bold(line);
			}
			body.push(truncateToWidth(line, width));
			rendered++;

			if (this.expanded.has(skill.name)) {
				if (rendered >= bodyBudget) break;
				body.push(truncateToWidth(theme.fg("dim", `    ${skill.description}`), width));
				rendered++;
				if (rendered >= bodyBudget) break;
				body.push(truncateToWidth(theme.fg("dim", `    ${skill.filePath}`), width));
				rendered++;
			}
		}

		if (this.flat.length === 0) {
			body.push(theme.fg("muted", "No skills match this filter"));
		}

		// Pad the list region so the footer sits on the panel's bottom edge.
		while (body.length < bodyBudget) body.push("");
		if (body.length > bodyBudget) body.length = bodyBudget;

		const lines = [...header, ...body, "", footer];
		this.cachedWidth = width;
		this.cachedRows = termRows;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width));
		return this.cachedLines;
	}
}

/**
 * Official Pi chrome: DynamicBorder + Box with theme background.
 * Box pads every line to width then paints bg — no transcript bleed-through.
 */
export class ProjectSkillsOverlay implements Component {
	private readonly box: Box;
	private readonly panel: ProjectSkillsPanel;

	constructor(
		projectDir: string,
		agentDir: string,
		catalog: Catalog,
		theme: Theme,
		keybindings: KeybindingsManager,
		tui: TUI,
		done: (result: UiResult) => void,
	) {
		this.panel = new ProjectSkillsPanel(projectDir, agentDir, catalog, theme, keybindings, tui, done);
		// userMessageBg is a solid theme panel background (same family as chat bubbles).
		// Padding 2 keeps title/rows/footer comfortably inside the border.
		this.box = new Box(2, 2, (text) => theme.bg("userMessageBg", text));
		this.box.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.box.addChild(this.panel);
		this.box.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
	}

	render(width: number): string[] {
		return this.box.render(width);
	}

	handleInput(data: string): void {
		this.panel.handleInput(data);
	}

	invalidate(): void {
		this.box.invalidate();
	}
}

/** Build overlay for tests / smoke renders without a live TUI session. */
export function createProjectSkillsOverlay(
	projectDir: string,
	agentDir: string,
	catalog: Catalog,
	theme: Theme,
	keybindings: KeybindingsManager,
	tui: TUI,
	done: (result: UiResult) => void = () => {},
): ProjectSkillsOverlay {
	return new ProjectSkillsOverlay(projectDir, agentDir, catalog, theme, keybindings, tui, done);
}
