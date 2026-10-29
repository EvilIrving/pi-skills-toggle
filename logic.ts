import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	formatSkillsForPrompt,
	getAgentDir,
	loadSkills,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MARKER_NAME = "pi-skills-toggle";
export const MARKER_FILE = ".pi-skills-toggle.json";
export const LEGACY_MARKER_NAME = "pi-project-skill-toggle";
export const LEGACY_MARKER_FILE = ".pi-project-skill-toggle.json";
export const SKILL_FILE = "SKILL.md";

export type SkillOrigin = "user" | "agents" | "package" | "project" | "path";
export type FilterScope = "all" | "global" | "project";

export interface MarkerV1 {
	managedBy: typeof MARKER_NAME;
	name: string;
	version: 1;
	skillSha256: string;
}

export interface ListedSkill {
	name: string;
	description: string;
	filePath: string;
	origin: SkillOrigin;
	scopeLabel: string;
	/** True when this row is a global/package skill we can exclude in the project. */
	toggleable: boolean;
	/** True when a managed stub currently excludes it from model invocation. */
	excluded: boolean;
	/** True when a non-managed project skill already owns this name. */
	ownedByProject: boolean;
	disableModelInvocation: boolean;
}

export interface Catalog {
	skills: ListedSkill[];
	excludedCount: number;
	toggleableCount: number;
	diagnostics: string[];
}

function projectSkillsDir(projectDir: string): string {
	return path.join(projectDir, CONFIG_DIR_NAME, "skills");
}

/** Agent Skills / Pi portable name: lowercase, digits, single hyphens, ≤64. */
export function isValidSkillSlug(name: string): boolean {
	if (typeof name !== "string" || name.length === 0 || name.length > 64) return false;
	if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return false;
	if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function lstatOptional(filePath: string): fs.Stats | undefined {
	try {
		return fs.lstatSync(filePath);
	} catch {
		return undefined;
	}
}

function assertRegularPath(filePath: string, label: string): fs.Stats {
	const st = lstatOptional(filePath);
	if (!st) throw new Error(`${label} does not exist: ${filePath}`);
	if (st.isSymbolicLink()) throw new Error(`${label} is a symlink; refusing: ${filePath}`);
	return st;
}

function assertInsideSkillsDir(skillsReal: string, candidateReal: string, expectedName: string): void {
	const rel = path.relative(skillsReal, candidateReal);
	if (rel !== expectedName || path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
		throw new Error(`Path escapes project skills directory: ${candidateReal}`);
	}
}

function resolveProjectRoot(projectDir: string): string {
	const resolved = path.resolve(projectDir);
	const st = lstatOptional(resolved);
	if (!st) throw new Error(`Project directory does not exist: ${resolved}`);
	// projectDir itself may be a symlink; follow it once to the real project root.
	return fs.realpathSync(resolved);
}

/** Ensure `.pi` (and skills) are real dirs under the project — never symlink escapes. */
function assertSafePiSkillsLayout(projectReal: string): { piPath: string; skillsPath: string } {
	const piPath = path.join(projectReal, CONFIG_DIR_NAME);
	const skillsPath = path.join(piPath, "skills");
	const piStat = lstatOptional(piPath);
	if (piStat?.isSymbolicLink()) {
		throw new Error(`.pi is a symlink; refusing to use skills outside the project: ${piPath}`);
	}
	const skillsStat = lstatOptional(skillsPath);
	if (skillsStat?.isSymbolicLink()) {
		throw new Error(`skills directory is a symlink; refusing: ${skillsPath}`);
	}
	return { piPath, skillsPath };
}

function assertSkillsRootInsideProject(projectReal: string, skillsReal: string): void {
	const expected = path.join(projectReal, CONFIG_DIR_NAME, "skills");
	if (skillsReal !== expected) {
		throw new Error(`Skills root escaped project (expected ${expected}, got ${skillsReal})`);
	}
}

/** Resolve skills root as a real, non-symlink directory when it exists. */
export function resolveSkillsRoot(projectDir: string, options?: { create?: boolean }): string {
	const projectReal = resolveProjectRoot(projectDir);
	const { piPath, skillsPath } = assertSafePiSkillsLayout(projectReal);

	if (!fs.existsSync(skillsPath)) {
		if (!options?.create) return skillsPath;
		if (!fs.existsSync(piPath)) {
			fs.mkdirSync(piPath, { recursive: false });
			assertRegularPath(piPath, ".pi directory");
		} else {
			assertRegularPath(piPath, ".pi directory");
		}
		fs.mkdirSync(skillsPath, { recursive: false });
	}

	const st = assertRegularPath(skillsPath, "skills directory");
	if (!st.isDirectory()) throw new Error(`skills path is not a directory: ${skillsPath}`);
	const skillsReal = fs.realpathSync(skillsPath);
	assertSkillsRootInsideProject(projectReal, skillsReal);
	return skillsReal;
}

/**
 * Resolve `<skills>/<slug>` as a direct child of the real skills directory.
 * Rejects invalid slugs, traversal, and symlink directories.
 */
export function resolveManagedSkillDir(
	projectDir: string,
	name: string,
	options?: { createRoot?: boolean; mustExist?: boolean },
): { skillsReal: string; skillDir: string; exists: boolean } {
	if (!isValidSkillSlug(name)) {
		throw new Error(`Invalid skill name (expected portable slug): ${name}`);
	}
	const skillsReal = resolveSkillsRoot(projectDir, { create: options?.createRoot });
	const skillDir = path.join(skillsReal, name);
	const st = lstatOptional(skillDir);
	if (!st) {
		if (options?.mustExist) throw new Error(`Managed skill directory missing: ${skillDir}`);
		// Non-existent path still has to stay a direct child of skillsReal.
		assertInsideSkillsDir(skillsReal, path.resolve(skillDir), name);
		return { skillsReal, skillDir: path.resolve(skillDir), exists: false };
	}
	if (st.isSymbolicLink()) {
		throw new Error(`Skill directory is a symlink; refusing: ${skillDir}`);
	}
	if (!st.isDirectory()) {
		throw new Error(`Skill path is not a directory: ${skillDir}`);
	}
	const realDir = fs.realpathSync(skillDir);
	assertInsideSkillsDir(skillsReal, realDir, name);
	return { skillsReal, skillDir: realDir, exists: true };
}

export function stubSkillMarkdown(name: string): string {
	if (!isValidSkillSlug(name)) {
		throw new Error(`Invalid skill name for stub: ${name}`);
	}
	return [
		"---",
		`name: ${name}`,
		`description: Excluded in this project by ${MARKER_NAME}.`,
		"disable-model-invocation: true",
		"---",
		"",
	].join("\n");
}

export function hashStub(name: string): string {
	return createHash("sha256").update(stubSkillMarkdown(name)).digest("hex");
}

export function readMarker(filePath: string): MarkerV1 | undefined {
	try {
		const st = lstatOptional(filePath);
		if (!st || st.isSymbolicLink() || !st.isFile()) return undefined;
		const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MarkerV1>;
		if (data.managedBy !== MARKER_NAME) return undefined;
		if (typeof data.name !== "string" || !isValidSkillSlug(data.name)) return undefined;
		if (data.version !== 1 || typeof data.skillSha256 !== "string") return undefined;
		return data as MarkerV1;
	} catch {
		return undefined;
	}
}

export function isIntactManagedStub(skillDir: string, expectedName?: string): boolean {
	const dirName = path.basename(skillDir);
	const name = expectedName ?? dirName;
	if (!isValidSkillSlug(name) || name !== dirName) return false;
	const dirStat = lstatOptional(skillDir);
	if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;

	const markerPath = path.join(skillDir, MARKER_FILE);
	const skillPath = path.join(skillDir, SKILL_FILE);
	const marker = readMarker(markerPath);
	if (!marker || marker.name !== name) return false;
	const skillStat = lstatOptional(skillPath);
	if (!skillStat || skillStat.isSymbolicLink() || !skillStat.isFile()) return false;
	try {
		const current = createHash("sha256").update(fs.readFileSync(skillPath, "utf8")).digest("hex");
		return current === marker.skillSha256 && current === hashStub(name);
	} catch {
		return false;
	}
}

export function listManagedExclusions(projectDir: string): Map<string, { dir: string; intact: boolean }> {
	const out = new Map<string, { dir: string; intact: boolean }>();
	let skillsReal: string;
	try {
		if (!fs.existsSync(projectSkillsDir(projectDir))) return out;
		skillsReal = resolveSkillsRoot(projectDir);
	} catch {
		return out;
	}
	for (const entry of fs.readdirSync(skillsReal, { withFileTypes: true })) {
		// Never follow symlink directories into managed exclusions.
		if (entry.isSymbolicLink()) continue;
		if (!entry.isDirectory()) continue;
		if (!isValidSkillSlug(entry.name)) continue;
		const dir = path.join(skillsReal, entry.name);
		let realDir: string;
		try {
			const st = assertRegularPath(dir, "skill directory");
			if (!st.isDirectory()) continue;
			realDir = fs.realpathSync(dir);
			assertInsideSkillsDir(skillsReal, realDir, entry.name);
		} catch {
			continue;
		}
		const marker = readMarker(path.join(realDir, MARKER_FILE));
		// Marker name must match the directory basename; otherwise not managed/toggleable.
		if (!marker || marker.name !== entry.name) continue;
		out.set(entry.name, { dir: realDir, intact: isIntactManagedStub(realDir, entry.name) });
	}
	return out;
}

function originFromMeta(meta: { source?: string; scope?: string; origin?: string; packageRoot?: string } | undefined, filePath: string, projectDir: string, agentDir: string): SkillOrigin {
	// Project-scoped resources (including project packages) are not global exclusion targets.
	if (meta?.scope === "project") return "project";
	if (meta?.origin === "package" || meta?.packageRoot) return "package";
	const normalized = path.resolve(filePath);
	const projectPi = path.resolve(projectSkillsDir(projectDir)) + path.sep;
	const projectAgents = path.resolve(projectDir, ".agents", "skills") + path.sep;
	const userPi = path.resolve(agentDir, "skills") + path.sep;
	const userAgents = path.resolve(os.homedir(), ".agents", "skills") + path.sep;
	if (normalized.startsWith(projectPi) || normalized.startsWith(projectAgents)) return "project";
	if (normalized.startsWith(userAgents)) return "agents";
	if (normalized.startsWith(userPi)) return "user";
	if (meta?.source === "agents") return "agents";
	return meta?.scope === "user" ? "user" : "path";
}

/** Exported for tests: classify whether a skill row should be toggleable. */
export function isToggleableOrigin(origin: SkillOrigin): boolean {
	return origin !== "project";
}

function scopeLabel(origin: SkillOrigin): string {
	switch (origin) {
		case "user":
			return "user";
		case "agents":
			return "agents";
		case "package":
			return "package";
		case "project":
			return "project";
		default:
			return "path";
	}
}

function isManagedStubPath(filePath: string, managed: Map<string, { dir: string; intact: boolean }>): boolean {
	const dir = path.dirname(filePath);
	for (const entry of managed.values()) {
		if (path.resolve(entry.dir) === path.resolve(dir)) return true;
	}
	return false;
}

/**
 * Build the project skill catalog using Pi's package-manager path order + loadSkills
 * first-name-wins semantics. Managed stubs are temporarily ignored so the shadowed
 * global skill remains visible and toggleable.
 */
export async function buildCatalog(projectDir: string, agentDir = getAgentDir()): Promise<Catalog> {
	const managed = listManagedExclusions(projectDir);
	const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
	settingsManager.setProjectTrusted(true);
	const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");
	const metadataByPath = new Map(resolved.skills.map((entry) => [path.resolve(entry.path), entry.metadata]));

	const skillPaths = resolved.skills
		.filter((entry) => entry.enabled)
		.map((entry) => entry.path)
		.filter((p) => {
			try {
				const st = fs.statSync(p);
				const filePath = st.isDirectory() ? path.join(p, SKILL_FILE) : p;
				return !isManagedStubPath(filePath, managed) && !isManagedStubPath(p, managed);
			} catch {
				return true;
			}
		});

	// Also drop whole managed stub directories from directory paths.
	const filteredPaths = skillPaths.filter((p) => {
		const resolvedPath = path.resolve(p);
		for (const entry of managed.values()) {
			const stub = path.resolve(entry.dir);
			if (resolvedPath === stub || resolvedPath.startsWith(stub + path.sep)) return false;
		}
		return true;
	});

	const loaded = loadSkills({
		cwd: projectDir,
		agentDir,
		skillPaths: filteredPaths,
		includeDefaults: false,
	});

	const listed: ListedSkill[] = [];
	for (const skill of loaded.skills) {
		const meta = metadataByPath.get(path.resolve(skill.filePath))
			?? metadataByPath.get(path.resolve(skill.baseDir))
			?? findMetaForSkill(skill, metadataByPath);
		const origin = originFromMeta(meta, skill.filePath, projectDir, agentDir);
		const excluded = managed.has(skill.name);
		const ownedByProject = origin === "project";
		listed.push({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			origin,
			scopeLabel: scopeLabel(origin),
			toggleable: isToggleableOrigin(origin),
			excluded,
			ownedByProject,
			disableModelInvocation: skill.disableModelInvocation,
		});
	}

	// Orphan managed stubs whose global skill disappeared still show as excluded rows.
	for (const [name, entry] of managed) {
		if (listed.some((s) => s.name === name)) continue;
		listed.push({
			name,
			description: entry.intact
				? `Excluded stub (global skill missing)`
				: `Managed stub modified or incomplete`,
			filePath: path.join(entry.dir, SKILL_FILE),
			origin: "project",
			scopeLabel: "stub",
			toggleable: entry.intact,
			excluded: true,
			ownedByProject: false,
			disableModelInvocation: true,
		});
	}

	listed.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

	return {
		skills: listed,
		excludedCount: listed.filter((s) => s.excluded).length,
		toggleableCount: listed.filter((s) => s.toggleable).length,
		diagnostics: loaded.diagnostics
			.filter((d) => d.type === "collision" || d.type === "warning" || d.type === "error")
			.map((d) => `${d.type}: ${d.message}${d.path ? ` (${d.path})` : ""}`),
	};
}

function findMetaForSkill(skill: Skill, metadataByPath: Map<string, { source: string; scope: string; origin: "package" | "top-level"; baseDir?: string; packageRoot?: string }>) {
	for (const [resourcePath, meta] of metadataByPath) {
		const root = meta.baseDir ? path.resolve(meta.baseDir) : resourcePath;
		if (path.resolve(skill.filePath).startsWith(root + path.sep) || path.resolve(skill.filePath) === root) {
			return meta;
		}
		if (path.resolve(skill.baseDir).startsWith(root + path.sep) || path.resolve(skill.baseDir) === root) {
			return meta;
		}
	}
	return undefined;
}

export function filterSkills(skills: ListedSkill[], query: string, scope: FilterScope): ListedSkill[] {
	const q = query.trim().toLocaleLowerCase();
	return skills.filter((skill) => {
		if (scope === "global") {
			// Globals + exclusions of globals (not pure project-owned skills).
			if (skill.ownedByProject && !skill.excluded) return false;
		}
		if (scope === "project") {
			// Real project skills and anything currently excluded in this project.
			if (!(skill.origin === "project" || skill.excluded)) return false;
		}
		if (!q) return true;
		return `${skill.name} ${skill.description} ${skill.scopeLabel}`.toLocaleLowerCase().includes(q);
	});
}

export function groupSkills(skills: ListedSkill[]): { title: string; items: ListedSkill[] }[] {
	const order: { key: string; title: string; match: (s: ListedSkill) => boolean }[] = [
		{ key: "user", title: "User", match: (s) => s.origin === "user" && !s.excluded },
		{ key: "agents", title: "Agents", match: (s) => s.origin === "agents" && !s.excluded },
		{ key: "package", title: "Package", match: (s) => s.origin === "package" && !s.excluded },
		{ key: "path", title: "Path", match: (s) => s.origin === "path" && !s.excluded },
		{ key: "excluded", title: "Excluded in project", match: (s) => s.excluded },
		{ key: "project", title: "Project", match: (s) => s.origin === "project" && !s.excluded },
	];
	const groups: { title: string; items: ListedSkill[] }[] = [];
	for (const entry of order) {
		const items = skills.filter(entry.match);
		if (items.length === 0) continue;
		groups.push({ title: `${entry.title} (${items.length} skill${items.length === 1 ? "" : "s"})`, items });
	}
	return groups;
}

const OWNED_STUB_FILES = new Set([SKILL_FILE, MARKER_FILE]);

export type StubMutationResult = {
	ok: true;
	/** Directory still exists because non-owned files remain. */
	leftBehind?: string[];
	message?: string;
};

function listDirEntries(skillDir: string): string[] {
	if (!fs.existsSync(skillDir)) return [];
	return fs.readdirSync(skillDir);
}

function nonOwnedEntries(skillDir: string): string[] {
	return listDirEntries(skillDir).filter((name) => !OWNED_STUB_FILES.has(name));
}

export function writeExclusionStub(projectDir: string, name: string): StubMutationResult {
	const { skillDir, exists } = resolveManagedSkillDir(projectDir, name, { createRoot: true });
	if (exists) {
		const marker = readMarker(path.join(skillDir, MARKER_FILE));
		if (!marker || marker.name !== name) {
			const extras = nonOwnedEntries(skillDir);
			throw new Error(
				extras.length > 0
					? `Refusing to write stub over project skill with extra files (${extras.join(", ")}): ${skillDir}`
					: `Refusing to overwrite existing project skill: ${skillDir}`,
			);
		}
		if (!isIntactManagedStub(skillDir, name)) {
			throw new Error(`Managed stub was modified; not overwriting owned files: ${skillDir}`);
		}
		// Refuse to follow/replace symlinked owned files.
		for (const owned of OWNED_STUB_FILES) {
			const ownedPath = path.join(skillDir, owned);
			const st = lstatOptional(ownedPath);
			if (st?.isSymbolicLink()) {
				throw new Error(`Owned stub file is a symlink; refusing: ${ownedPath}`);
			}
		}
	} else {
		fs.mkdirSync(skillDir, { recursive: false });
		const st = assertRegularPath(skillDir, "skill directory");
		if (!st.isDirectory()) throw new Error(`Failed to create skill directory: ${skillDir}`);
	}

	const body = stubSkillMarkdown(name);
	const skillPath = path.join(skillDir, SKILL_FILE);
	const markerPath = path.join(skillDir, MARKER_FILE);
	fs.writeFileSync(skillPath, body, "utf8");
	const marker: MarkerV1 = {
		managedBy: MARKER_NAME,
		name,
		version: 1,
		skillSha256: hashStub(name),
	};
	fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
	const leftBehind = nonOwnedEntries(skillDir);
	return leftBehind.length > 0
		? {
				ok: true,
				leftBehind,
				message: `Excluded ${name}; left existing files untouched: ${leftBehind.join(", ")}`,
			}
		: { ok: true };
}

export function removeExclusionStub(projectDir: string, name: string): StubMutationResult {
	const resolved = resolveManagedSkillDir(projectDir, name, { mustExist: false });
	if (!resolved.exists) return { ok: true };
	const { skillDir } = resolved;
	const markerPath = path.join(skillDir, MARKER_FILE);
	const skillPath = path.join(skillDir, SKILL_FILE);
	const marker = readMarker(markerPath);
	if (!marker || marker.name !== name) {
		throw new Error(`Not a managed stub; leaving untouched: ${skillDir}`);
	}
	if (!isIntactManagedStub(skillDir, name)) {
		throw new Error(`Managed stub was modified; not deleting owned files: ${skillDir}`);
	}
	assertRegularPath(skillPath, "SKILL.md");
	assertRegularPath(markerPath, "marker");

	fs.unlinkSync(skillPath);
	fs.unlinkSync(markerPath);

	const leftBehind = listDirEntries(skillDir);
	if (leftBehind.length === 0) {
		assertRegularPath(skillDir, "skill directory");
		fs.rmdirSync(skillDir);
		return { ok: true };
	}
	return {
		ok: true,
		leftBehind,
		message: `Restored ${name}; kept non-owned files in ${skillDir}: ${leftBehind.join(", ")}`,
	};
}

export function setExcluded(projectDir: string, name: string, excluded: boolean): StubMutationResult {
	return excluded ? writeExclusionStub(projectDir, name) : removeExclusionStub(projectDir, name);
}

/** Prove a stub actually wins and is omitted from the model prompt. */
export function verifyShadow(projectDir: string, agentDir: string, skillName: string): {
	winnerPath: string;
	inPrompt: boolean;
	disableModelInvocation: boolean;
} {
	const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
	settingsManager.setProjectTrusted(true);
	const packageManager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
	// resolve is async; callers that need full fidelity should use buildCatalog.
	// This sync helper only loads defaults-style paths for unit tests.
	const loaded = loadSkills({
		cwd: projectDir,
		agentDir,
		skillPaths: [
			path.join(projectDir, CONFIG_DIR_NAME, "skills"),
			path.join(agentDir, "skills"),
		],
		includeDefaults: false,
	});
	const winner = loaded.skills.find((s) => s.name === skillName);
	if (!winner) throw new Error(`Skill not found after shadow: ${skillName}`);
	const prompt = formatSkillsForPrompt([winner]);
	return {
		winnerPath: winner.filePath,
		inPrompt: prompt.includes(`<name>${skillName}</name>`),
		disableModelInvocation: winner.disableModelInvocation,
	};
}

export const FILTER_CYCLE: FilterScope[] = ["all", "global", "project"];

export function nextFilter(current: FilterScope): FilterScope {
	const idx = FILTER_CYCLE.indexOf(current);
	return FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length]!;
}
