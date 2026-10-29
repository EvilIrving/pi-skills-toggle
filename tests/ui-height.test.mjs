import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const {
	createProjectSkillsOverlay,
	computePanelTargetHeight,
	OVERLAY_LAYOUT,
	PANEL_CHROME_LINES,
} = await import(pathToFileURL(path.join(root, "ui.ts")).href);

function fakeTheme() {
	return {
		fg: (_c, t) => t,
		bg: (c, t) => `[bg:${c}]${t}[/bg]`,
		bold: (t) => `*${t}*`,
		style: (t) => t,
	};
}

function fakeTui(rows = 40) {
	return {
		terminal: { rows, columns: 100 },
		requestRender() {},
	};
}

function skill(name, overrides = {}) {
	return {
		name,
		description: `Description for ${name}`,
		filePath: `/u/${name}/SKILL.md`,
		origin: "user",
		scopeLabel: "user",
		toggleable: true,
		excluded: false,
		ownedByProject: false,
		disableModelInvocation: false,
		...overrides,
	};
}

function catalogOf(count) {
	const skills = Array.from({ length: count }, (_, i) => skill(`skill-${String(i + 1).padStart(2, "0")}`));
	return { skills, excludedCount: 0, toggleableCount: skills.length, diagnostics: [] };
}

function overlayFor(catalog, rows, keybindings = { matches: () => false }) {
	return createProjectSkillsOverlay(
		"/tmp",
		"/tmp/agent",
		catalog,
		fakeTheme(),
		keybindings,
		fakeTui(rows),
	);
}

function plain(lines) {
	return lines.map((line) => line.replace(/^\[bg:[^\]]+\]/, "").replace(/\[\/bg\]$/, ""));
}

function expectedOverlayMax(rows) {
	const avail = Math.max(1, rows - OVERLAY_LAYOUT.margin * 2);
	return Math.max(1, Math.min(Math.floor(rows * OVERLAY_LAYOUT.maxHeightPercent), avail));
}

test("panel target height mirrors overlay maxHeight", () => {
	for (const rows of [24, 40, 60, 80]) {
		const target = computePanelTargetHeight(rows);
		const painted = target + OVERLAY_LAYOUT.boxPaddingY * 2 + OVERLAY_LAYOUT.borderLines;
		assert.equal(painted, expectedOverlayMax(rows), `rows=${rows} should fill overlay max height`);
	}
	assert.ok(PANEL_CHROME_LINES >= 5);
});

test("overlay fills the available height at rows=40", () => {
	const overlay = overlayFor(catalogOf(30), 40);
	const lines = overlay.render(90);
	assert.equal(lines.length, expectedOverlayMax(40), "render should reach overlay maxHeight, not a fixed list cap");
	for (const line of lines) assert.ok(line.includes("[bg:userMessageBg]"));
});

test("overlay fills the available height at rows=60 and shows more rows than rows=40", () => {
	const catalog = catalogOf(40);
	const short = overlayFor(catalog, 40).render(90);
	const tall = overlayFor(catalog, 60).render(90);
	assert.equal(short.length, expectedOverlayMax(40));
	assert.equal(tall.length, expectedOverlayMax(60));
	assert.ok(tall.length > short.length);

	const countSkills = (lines) => plain(lines).filter((l) => /skill-\d\d/.test(l)).length;
	assert.ok(countSkills(tall) > countSkills(short), "taller terminal must render more skill rows");
});

test("footer stays on the last line and list region is padded", () => {
	const overlay = overlayFor(catalogOf(2), 40);
	const lines = plain(overlay.render(90));
	// Box paints paddingY=2 below the bottom border, so the footer is 4th from last.
	assert.match(lines.at(-4), /space (disable|enable|toggle)/);
	assert.ok(lines.at(-5).trim() === "", "blank line before footer");
	assert.ok(lines.at(-3).includes("─"), "bottom border after footer");
	// Painted rows are padded to full width so the Box background reaches the edges.
	for (const line of lines) assert.equal(visibleWidth(line), 90);
});

test("selection scrolls into view and stays inside the render", () => {
	const catalog = catalogOf(40);
	let matches = () => false;
	const kb = { matches: (data, key) => matches(data, key) };
	const overlay = overlayFor(catalog, 30, kb);
	matches = (data, key) => key === "tui.select.down" && data === "\u001b[B";

	for (let i = 0; i < 30; i++) overlay.handleInput("\u001b[B");
	const lines = plain(overlay.render(90));
	const selectedLine = lines.find((l) => l.includes("›"));
	assert.ok(selectedLine, "a selected row must be visible");
	assert.ok(selectedLine.includes("skill-31"), `selection should follow navigation, got: ${selectedLine.trim()}`);
	assert.ok(lines.length === expectedOverlayMax(30));
});

test("rendered height follows terminal rows changes (resize)", () => {
	const catalog = catalogOf(30);
	const tui = fakeTui(24);
	const overlay = createProjectSkillsOverlay(
		"/tmp",
		"/tmp/agent",
		catalog,
		fakeTheme(),
		{ matches: () => false },
		tui,
	);
	const before = overlay.render(90).length;
	tui.terminal.rows = 50;
	const after = overlay.render(90).length;
	assert.ok(after > before, `resize must re-render taller (${before} -> ${after})`);
	assert.equal(after, expectedOverlayMax(50));
});

test("narrow terminal keeps bordered, padded panel", () => {
	const overlay = overlayFor(catalogOf(6), 40);
	const lines = overlay.render(40);
	assert.ok(lines.length >= 10);
	assert.ok(lines.every((l) => l.includes("[bg:userMessageBg]")));
	assert.ok(lines.some((l) => l.includes("─")));
	for (const line of plain(lines)) assert.equal(visibleWidth(line), 40);
});
