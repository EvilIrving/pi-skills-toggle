import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const {
	loadSkills,
	formatSkillsForPrompt,
	SettingsManager,
	DefaultPackageManager,
} = await import("@earendil-works/pi-coding-agent");

const logic = await import(pathToFileURL(path.join(root, "logic.ts")).href);
const {
	stubSkillMarkdown,
	hashStub,
	writeExclusionStub,
	removeExclusionStub,
	listManagedExclusions,
	isIntactManagedStub,
	filterSkills,
	groupSkills,
	setExcluded,
	isValidSkillSlug,
	isToggleableOrigin,
	resolveSkillsRoot,
	MARKER_FILE,
	MARKER_NAME,
} = logic;

function writeSkill(dir, name, description, extraFront = "") {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extraFront}---\n\nBody for ${name}.\n`,
	);
}

function tempFixture() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pst-test-"));
	const agentDir = path.join(rootDir, "agent");
	const projectA = path.join(rootDir, "project-a");
	const projectB = path.join(rootDir, "project-b");
	fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
	fs.mkdirSync(path.join(projectA, ".pi", "skills"), { recursive: true });
	fs.mkdirSync(path.join(projectB, ".pi", "skills"), { recursive: true });
	writeSkill(path.join(agentDir, "skills", "alpha"), "alpha", "Global alpha skill");
	writeSkill(path.join(agentDir, "skills", "beta"), "beta", "Global beta skill");
	writeSkill(path.join(agentDir, "skills", "gamma"), "gamma", "Global gamma skill");
	writeSkill(path.join(projectA, ".pi", "skills", "local-only"), "local-only", "Project A local skill");
	return { rootDir, agentDir, projectA, projectB };
}

test("stub markdown hashes are stable", () => {
	const a = stubSkillMarkdown("alpha");
	assert.equal(hashStub("alpha"), createHash("sha256").update(a).digest("hex"));
	assert.notEqual(hashStub("alpha"), hashStub("beta"));
});

test("write and remove intact stubs only", () => {
	const { projectA } = tempFixture();
	writeExclusionStub(projectA, "alpha");
	const managed = listManagedExclusions(projectA);
	assert.equal(managed.get("alpha")?.intact, true);

	removeExclusionStub(projectA, "alpha");
	assert.equal(listManagedExclusions(projectA).size, 0);
});

test("refuses to overwrite a real project skill", () => {
	const { projectA } = tempFixture();
	assert.throws(() => writeExclusionStub(projectA, "local-only"), /Refusing to overwrite/);
});

test("refuses to delete a modified stub", () => {
	const { projectA } = tempFixture();
	writeExclusionStub(projectA, "beta");
	const skillDir = path.join(projectA, ".pi", "skills", "beta");
	const skillFile = path.join(skillDir, "SKILL.md");
	fs.writeFileSync(skillFile, stubSkillMarkdown("beta") + "user edited\n");
	assert.equal(isIntactManagedStub(skillDir), false);
	assert.throws(() => removeExclusionStub(projectA, "beta"), /modified/);
	assert.ok(fs.existsSync(skillFile), "modified SKILL.md must remain");
	assert.ok(fs.existsSync(path.join(skillDir, MARKER_FILE)), "marker must remain when hash mismatches");
});

test("remove keeps user files and only deletes owned stub files", () => {
	const { projectA } = tempFixture();
	writeExclusionStub(projectA, "alpha");
	const skillDir = path.join(projectA, ".pi", "skills", "alpha");
	fs.writeFileSync(path.join(skillDir, "user.txt"), "keep me\n");
	fs.mkdirSync(path.join(skillDir, "references"));
	fs.writeFileSync(path.join(skillDir, "references", "note.md"), "notes\n");

	const result = removeExclusionStub(projectA, "alpha");
	assert.equal(result.ok, true);
	assert.ok(result.leftBehind?.includes("user.txt"));
	assert.ok(result.leftBehind?.includes("references"));
	assert.ok(result.message?.includes("kept non-owned"));
	assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), false);
	assert.equal(fs.existsSync(path.join(skillDir, MARKER_FILE)), false);
	assert.equal(fs.readFileSync(path.join(skillDir, "user.txt"), "utf8"), "keep me\n");
	assert.equal(fs.readFileSync(path.join(skillDir, "references", "note.md"), "utf8"), "notes\n");
	assert.ok(fs.existsSync(skillDir), "directory with user files must remain");
});

test("write refreshes owned files without touching extras on intact stub", () => {
	const { projectA } = tempFixture();
	writeExclusionStub(projectA, "alpha");
	const skillDir = path.join(projectA, ".pi", "skills", "alpha");
	fs.writeFileSync(path.join(skillDir, "user.txt"), "keep me\n");
	const result = writeExclusionStub(projectA, "alpha");
	assert.equal(result.ok, true);
	assert.deepEqual(result.leftBehind, ["user.txt"]);
	assert.equal(fs.readFileSync(path.join(skillDir, "user.txt"), "utf8"), "keep me\n");
	assert.equal(isIntactManagedStub(skillDir), true);
});

test("write refuses directory that has extras but is not a managed stub", () => {
	const { projectA } = tempFixture();
	const skillDir = path.join(projectA, ".pi", "skills", "foreign");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, "user.txt"), "nope\n");
	assert.throws(() => writeExclusionStub(projectA, "foreign"), /extra files/);
	assert.equal(fs.readFileSync(path.join(skillDir, "user.txt"), "utf8"), "nope\n");
});

test("project A exclusions do not affect project B", () => {
	const { agentDir, projectA, projectB } = tempFixture();
	setExcluded(projectA, "alpha", true);
	setExcluded(projectA, "beta", true);

	const load = (cwd) =>
		loadSkills({
			cwd,
			agentDir,
			skillPaths: [path.join(cwd, ".pi", "skills"), path.join(agentDir, "skills")],
			includeDefaults: false,
		});

	const a = load(projectA);
	const b = load(projectB);
	assert.equal(a.skills.find((s) => s.name === "alpha")?.disableModelInvocation, true);
	assert.equal(a.skills.find((s) => s.name === "beta")?.disableModelInvocation, true);
	assert.equal(b.skills.find((s) => s.name === "alpha")?.disableModelInvocation, false);
	assert.equal(b.skills.find((s) => s.name === "beta")?.disableModelInvocation, false);
	assert.ok(!formatSkillsForPrompt(a.skills).includes("<name>alpha</name>"));
	assert.ok(formatSkillsForPrompt(b.skills).includes("<name>alpha</name>"));
});

test("filter and group helpers", () => {
	const skills = [
		{ name: "a", description: "da", filePath: "/u/a", origin: "user", scopeLabel: "user", toggleable: true, excluded: false, ownedByProject: false, disableModelInvocation: false },
		{ name: "b", description: "db", filePath: "/p/b", origin: "project", scopeLabel: "project", toggleable: false, excluded: false, ownedByProject: true, disableModelInvocation: false },
		{ name: "c", description: "dc", filePath: "/u/c", origin: "user", scopeLabel: "user", toggleable: true, excluded: true, ownedByProject: false, disableModelInvocation: true },
	];
	assert.equal(filterSkills(skills, "", "all").length, 3);
	assert.equal(filterSkills(skills, "", "global").length, 2);
	assert.equal(filterSkills(skills, "", "project").length, 2);
	assert.equal(filterSkills(skills, "dc", "all").map((s) => s.name).join(), "c");
	const groups = groupSkills(skills);
	assert.ok(groups.some((g) => g.title.startsWith("User")));
	assert.ok(groups.some((g) => g.title.startsWith("Excluded")));
	assert.ok(groups.some((g) => g.title.startsWith("Project")));
});

test("slug validation rejects traversal names", () => {
	assert.equal(isValidSkillSlug("alpha"), true);
	assert.equal(isValidSkillSlug("../../outside"), false);
	assert.equal(isValidSkillSlug("evil/../outside"), false);
	assert.throws(() => hashStub("../../outside"), /Invalid skill name/);
	assert.throws(() => setExcluded(tempFixture().projectA, "../../outside", false), /Invalid skill name/);
});

test("traversal marker name is ignored and cannot delete outside files", () => {
	const { projectA } = tempFixture();
	const outside = path.join(projectA, "outside-target");
	fs.mkdirSync(outside, { recursive: true });
	const sentinel = path.join(outside, "SKILL.md");
	const sentinelMarker = path.join(outside, MARKER_FILE);
	fs.writeFileSync(sentinel, "SENTINEL\n");
	fs.writeFileSync(sentinelMarker, "SENTINEL-MARKER\n");

	const evilDir = path.join(projectA, ".pi", "skills", "evil");
	fs.mkdirSync(evilDir, { recursive: true });
	// Forged marker points outside via name; hash is irrelevant because slug/name checks fail first.
	fs.writeFileSync(
		path.join(evilDir, MARKER_FILE),
		`${JSON.stringify({
			managedBy: MARKER_NAME,
			name: "../../outside-target",
			version: 1,
			skillSha256: "00".repeat(32),
		}, null, 2)}\n`,
	);
	fs.writeFileSync(path.join(evilDir, "SKILL.md"), "forged\n");

	const managed = listManagedExclusions(projectA);
	assert.equal(managed.has("../../outside-target"), false);
	assert.equal(managed.has("evil"), false);
	assert.throws(() => removeExclusionStub(projectA, "../../outside-target"), /Invalid skill name/);
	assert.equal(fs.readFileSync(sentinel, "utf8"), "SENTINEL\n");
	assert.equal(fs.readFileSync(sentinelMarker, "utf8"), "SENTINEL-MARKER\n");
});

test("symlink skill directory is not managed and cannot mutate outside target", () => {
	const { projectA } = tempFixture();
	const outside = path.join(projectA, "linked-outside");
	fs.mkdirSync(outside, { recursive: true });
	const outsideSkill = path.join(outside, "SKILL.md");
	const outsideMarker = path.join(outside, MARKER_FILE);
	const body = stubSkillMarkdown("alpha");
	fs.writeFileSync(outsideSkill, body);
	fs.writeFileSync(
		outsideMarker,
		`${JSON.stringify({
			managedBy: MARKER_NAME,
			name: "alpha",
			version: 1,
			skillSha256: hashStub("alpha"),
		}, null, 2)}\n`,
	);

	const linkPath = path.join(projectA, ".pi", "skills", "alpha");
	fs.symlinkSync(outside, linkPath);

	const managed = listManagedExclusions(projectA);
	assert.equal(managed.has("alpha"), false);
	assert.throws(() => removeExclusionStub(projectA, "alpha"), /symlink/);
	assert.throws(() => writeExclusionStub(projectA, "alpha"), /symlink/);
	assert.equal(fs.readFileSync(outsideSkill, "utf8"), body);
	assert.ok(fs.existsSync(outsideMarker));
});

test("marker name mismatch with directory basename is not toggleable", () => {
	const { projectA } = tempFixture();
	const dir = path.join(projectA, ".pi", "skills", "alpha");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), stubSkillMarkdown("beta"));
	fs.writeFileSync(
		path.join(dir, MARKER_FILE),
		`${JSON.stringify({
			managedBy: MARKER_NAME,
			name: "beta",
			version: 1,
			skillSha256: hashStub("beta"),
		}, null, 2)}\n`,
	);
	const managed = listManagedExclusions(projectA);
	assert.equal(managed.has("alpha"), false);
	assert.equal(managed.has("beta"), false);
	assert.throws(() => removeExclusionStub(projectA, "alpha"), /Not a managed stub|modified/);
});

test("package-manager path order lets project stub win", async () => {
	const { agentDir, projectA } = tempFixture();
	writeExclusionStub(projectA, "gamma");
	const settingsManager = SettingsManager.create(projectA, agentDir, { projectTrusted: true });
	settingsManager.setProjectTrusted(true);
	const pm = new DefaultPackageManager({ cwd: projectA, agentDir, settingsManager });
	const resolved = await pm.resolve(async () => "skip");
	const loaded = loadSkills({
		cwd: projectA,
		agentDir,
		skillPaths: resolved.skills.filter((s) => s.enabled).map((s) => s.path),
		includeDefaults: false,
	});
	const gamma = loaded.skills.find((s) => s.name === "gamma");
	assert.ok(gamma);
	assert.equal(gamma.disableModelInvocation, true);
	assert.ok(gamma.filePath.includes(`${path.sep}.pi${path.sep}skills${path.sep}gamma`));
	assert.ok(!formatSkillsForPrompt([gamma]).includes("<name>gamma</name>"));
	assert.ok(fs.existsSync(path.join(projectA, ".pi", "skills", "gamma", MARKER_FILE)));
});

test("project-scoped package origin is not toggleable", () => {
	assert.equal(isToggleableOrigin("project"), false);
	assert.equal(isToggleableOrigin("package"), true);
	assert.equal(isToggleableOrigin("user"), true);
});

test("project package skill is project-owned; stub still wins by rank but UI must not toggle it", async () => {
	const { agentDir, projectA } = tempFixture();
	const pkgDir = path.join(projectA, "vendor-skill-pack");
	fs.mkdirSync(path.join(pkgDir, "skills", "pkg-skill"), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "vendor-skill-pack", version: "1.0.0", pi: { skills: ["./skills"] } }, null, 2),
	);
	writeSkill(path.join(pkgDir, "skills", "pkg-skill"), "pkg-skill", "From project package");
	fs.writeFileSync(
		path.join(projectA, ".pi", "settings.json"),
		JSON.stringify({ packages: [pkgDir] }, null, 2),
	);

	const settingsManager = SettingsManager.create(projectA, agentDir, { projectTrusted: true });
	settingsManager.setProjectTrusted(true);
	const pm = new DefaultPackageManager({ cwd: projectA, agentDir, settingsManager });
	const resolved = await pm.resolve(async () => "skip");
	const pkgEntry = resolved.skills.find((s) => s.path.includes("pkg-skill") && s.metadata.origin === "package");
	assert.ok(pkgEntry);
	assert.equal(pkgEntry.metadata.scope, "project");

	// Without stub, package skill wins.
	const before = loadSkills({
		cwd: projectA,
		agentDir,
		skillPaths: resolved.skills.filter((s) => s.enabled).map((s) => s.path),
		includeDefaults: false,
	});
	assert.equal(before.skills.find((s) => s.name === "pkg-skill")?.disableModelInvocation, false);

	// Stub ranks above package (project auto < package), so a stub would win — but UI marks project scope non-toggleable.
	writeExclusionStub(projectA, "pkg-skill");
	const afterResolved = await pm.resolve(async () => "skip");
	const after = loadSkills({
		cwd: projectA,
		agentDir,
		skillPaths: afterResolved.skills.filter((s) => s.enabled).map((s) => s.path),
		includeDefaults: false,
	});
	const winner = after.skills.find((s) => s.name === "pkg-skill");
	assert.ok(winner);
	assert.equal(winner.disableModelInvocation, true);
	assert.ok(winner.filePath.includes(`${path.sep}.pi${path.sep}skills${path.sep}pkg-skill`));
	assert.equal(isToggleableOrigin("project"), false);
});

test("rejects .pi symlink that points skills outside the project", () => {
	const { projectA } = tempFixture();
	const outside = path.join(projectA, "outside-pi");
	fs.mkdirSync(path.join(outside, "skills"), { recursive: true });
	const sentinel = path.join(outside, "skills", "sentinel.txt");
	fs.writeFileSync(sentinel, "OUTSIDE\n");

	// Replace .pi with a symlink to outside-pi.
	fs.rmSync(path.join(projectA, ".pi"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(projectA, ".pi"));

	assert.throws(() => resolveSkillsRoot(projectA), /\.pi is a symlink/);
	assert.throws(() => writeExclusionStub(projectA, "alpha"), /\.pi is a symlink/);
	assert.equal(fs.readFileSync(sentinel, "utf8"), "OUTSIDE\n");
	assert.equal(listManagedExclusions(projectA).size, 0);
});
