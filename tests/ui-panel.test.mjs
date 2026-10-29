import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { createProjectSkillsOverlay } = await import(pathToFileURL(path.join(root, "ui.ts")).href);

function fakeTheme() {
	return {
		fg: (_c, t) => t,
		bg: (c, t) => `[bg:${c}]${t}[/bg]`,
		bold: (t) => `*${t}*`,
		style: (t) => t,
	};
}

test("overlay render uses DynamicBorder + opaque Box background", () => {
	const catalog = {
		skills: [
			{
				name: "alpha",
				description: "Global alpha",
				filePath: "/u/alpha/SKILL.md",
				origin: "user",
				scopeLabel: "user",
				toggleable: true,
				excluded: false,
				ownedByProject: false,
				disableModelInvocation: false,
			},
			{
				name: "beta",
				description: "Excluded beta",
				filePath: "/u/beta/SKILL.md",
				origin: "user",
				scopeLabel: "user",
				toggleable: true,
				excluded: true,
				ownedByProject: false,
				disableModelInvocation: true,
			},
		],
		excludedCount: 1,
		toggleableCount: 2,
		diagnostics: [],
	};
	const overlay = createProjectSkillsOverlay(
		"/tmp",
		"/tmp/agent",
		catalog,
		fakeTheme(),
		{ matches: () => false },
		{ requestRender() {} },
	);

	const width = 64;
	const lines = overlay.render(width);
	assert.ok(lines.length >= 6);
	const borderLines = lines.filter((l) => l.includes("─"));
	assert.ok(borderLines.length >= 2, "expected top and bottom DynamicBorder");
	// Box paddingY=2 adds two blank painted rows around the bordered card.
	assert.ok(lines[0].includes("[bg:userMessageBg]"));
	assert.ok(lines[1].includes("[bg:userMessageBg]"));
	assert.ok(lines[2].includes("─"), `expected top border after padding, got: ${lines[2]}`);
	assert.ok(lines.at(-3).includes("─"), `expected bottom border before padding, got: ${lines.at(-3)}`);
	for (const line of lines) {
		assert.ok(line.includes("[bg:userMessageBg]"), `line missing opaque bg: ${line.slice(0, 80)}`);
		// Box pads each child line to the overlay width before painting background.
		const inner = line.replace(/^\[bg:userMessageBg\]/, "").replace(/\[\/bg\]$/, "");
		assert.equal(visibleWidth(inner), width, `uneven painted width: ${JSON.stringify(inner.slice(0, 90))}`);
	}
	assert.ok(lines.some((l) => l.includes("Project Skills")));
	assert.ok(lines.some((l) => l.includes("alpha")));
	assert.ok(lines.some((l) => l.includes("[disabled]")));
});

test("narrow overlay still renders bordered panel", () => {
	const catalog = {
		skills: [
			{
				name: "alpha",
				description: "Global alpha",
				filePath: "/u/alpha/SKILL.md",
				origin: "user",
				scopeLabel: "user",
				toggleable: true,
				excluded: false,
				ownedByProject: false,
				disableModelInvocation: false,
			},
		],
		excludedCount: 0,
		toggleableCount: 1,
		diagnostics: [],
	};
	const overlay = createProjectSkillsOverlay(
		"/tmp",
		"/tmp/agent",
		catalog,
		fakeTheme(),
		{ matches: () => false },
		{ requestRender() {} },
	);
	const lines = overlay.render(40);
	assert.ok(lines.some((l) => l.includes("─")));
	assert.ok(lines.every((l) => l.includes("[bg:userMessageBg]")));
	assert.ok(lines[2].includes("─"));
});
