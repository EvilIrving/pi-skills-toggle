#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const MARKER = "pi-project-skill-toggle";
const stub = (name) =>
	`---\nname: ${name}\ndescription: Excluded in this project by ${MARKER}.\ndisable-model-invocation: true\n---\n\n`;
const hash = (name) => createHash("sha256").update(stub(name)).digest("hex");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pst-smoke-"));
const agentDir = path.join(tmp, "agent");
const projectDir = path.join(tmp, "proj");
fs.mkdirSync(path.join(agentDir, "skills", "demo-skill"), { recursive: true });
fs.mkdirSync(path.join(projectDir, ".pi", "skills"), { recursive: true });
fs.writeFileSync(
	path.join(agentDir, "skills", "demo-skill", "SKILL.md"),
	"---\nname: demo-skill\ndescription: A global demo skill for smoke testing.\n---\n\nDo the demo.\n",
);

const before = loadSkills({
	cwd: projectDir,
	agentDir,
	skillPaths: [path.join(projectDir, ".pi", "skills"), path.join(agentDir, "skills")],
	includeDefaults: false,
});
const beforeSkill = before.skills.find((s) => s.name === "demo-skill");
if (!beforeSkill || beforeSkill.disableModelInvocation) {
	throw new Error("expected global demo-skill before stub");
}
if (!formatSkillsForPrompt([beforeSkill]).includes("<name>demo-skill</name>")) {
	throw new Error("expected demo-skill in prompt before stub");
}

const stubDir = path.join(projectDir, ".pi", "skills", "demo-skill");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "SKILL.md"), stub("demo-skill"));
fs.writeFileSync(
	path.join(stubDir, ".pi-project-skill-toggle.json"),
	`${JSON.stringify({ managedBy: MARKER, name: "demo-skill", version: 1, skillSha256: hash("demo-skill") }, null, 2)}\n`,
);

const after = loadSkills({
	cwd: projectDir,
	agentDir,
	skillPaths: [path.join(projectDir, ".pi", "skills"), path.join(agentDir, "skills")],
	includeDefaults: false,
});
const afterSkill = after.skills.find((s) => s.name === "demo-skill");
if (!afterSkill?.disableModelInvocation) {
	throw new Error("expected stub to win with disable-model-invocation");
}
if (!afterSkill.filePath.includes(`${path.sep}.pi${path.sep}skills${path.sep}demo-skill`)) {
	throw new Error(`stub did not win: ${afterSkill.filePath}`);
}
if (formatSkillsForPrompt([afterSkill]).includes("<name>demo-skill</name>")) {
	throw new Error("disabled stub must not appear in formatSkillsForPrompt");
}

const collision = after.diagnostics.find((d) => d.type === "collision" && d.collision?.name === "demo-skill");
if (!collision) {
	throw new Error("expected name collision diagnostic for shadowed global skill");
}

console.log("smoke ok");
console.log(
	JSON.stringify(
		{
			agentDir: getAgentDir(),
			winner: afterSkill.filePath,
			disableModelInvocation: afterSkill.disableModelInvocation,
			collision: collision.collision,
		},
		null,
		2,
	),
);
