# pi-project-skill-toggle

English | [简体中文](README.md)

Per-project exclude/include for **global** Pi skills. Does not edit `~/.pi` skills or global settings.

## How it works

Pi 1.4 resolves skills through the package manager, then `loadSkills` keeps the first skill encountered for a given name. Project-level `.pi/skills` paths take precedence over user, agents, and package paths. A project-local skill with the same name shadows the global one.

`settings.skills` path filters are scoped to each settings file's base directory, so a project setting cannot reliably disable a user skill by name. This extension writes a managed project stub instead:

```text
.pi/skills/<name>/SKILL.md
.pi/skills/<name>/.pi-project-skill-toggle.json
```

The stub sets `disable-model-invocation: true`, so it wins name resolution and stays out of the model prompt. `/skill:<name>` manual invocation may still exist.

## Installation

Global install:

```bash
pi install npm:pi-project-skill-toggle
# or via Git repository:
pi install git:github.com/EvilIrving/pi-project-skill-toggle
```

Project-local install:

```bash
pi install npm:pi-project-skill-toggle --local
# or via Git repository:
pi install git:github.com/EvilIrving/pi-project-skill-toggle --local
```

Local directory install:

```bash
pi install ./path/to/pi-project-skill-toggle
# or local directory for current project:
pi install ./path/to/pi-project-skill-toggle --local
```

After installing, reload Pi (`/reload` or restart), then run:

```text
/project-skills
```

## Usage

This extension requires Pi's interactive terminal interface (TUI mode). Non-TUI mode triggers a warning notification.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `Space` | Toggle exclude or restore (action prompt shown; writes immediately to disk) |
| `f` | Cycle filter scope: All → Global → Project |
| `/` | Search skills |
| `Enter` | Expand or collapse description and file path |
| `r` | Reload skill catalog from disk |
| `Esc` | Close panel |

List rules:
- Rows show the skill source on the right: `user`, `agents`, `package`, or `project`.
- Excluded global skills appear muted with a red `[disabled]` tag.
- Existing project skills are listed but cannot be toggled or overwritten.

Requirement:
- After toggling, run `/reload` or restart Pi so active sessions load the updated stubs.

## Safety rules

- Only creates or modifies managed files: `SKILL.md` and `.pi-project-skill-toggle.json`.
- Restoring deletes only those two managed files; the directory is removed only if empty.
- Non-managed files or subdirectories (such as `references/` or `user.txt`) are never recursively deleted, and preserved files are reported in the UI.
- Managed files are deleted or overwritten only when their SHA-256 hash matches the recorded state. Modified stubs are left untouched.
- Refuses to overwrite existing non-managed project skills of the same name.
- Skill names must be portable slugs (lowercase alphanumeric and single hyphens, at most 64 characters). The marker file `name` must match the directory name.
- Stub paths must resolve inside the real `.pi/skills` directory. Symbolic links for skill directories or files are rejected.
- If the project `.pi` directory is a symbolic link pointing outside the project, execution is rejected.

## Support scope

Uses Pi's `DefaultPackageManager` and `loadSkills` for discovery.

Supported skill locations:
- `~/.pi/agent/skills`
- `~/.agents/skills`
- Project `.pi/skills` and ancestor `.agents/skills`
- Skills from configured Pi packages (npm, git, local)

Unsupported:
- Does not manage skills for Claude, Codex, or other tools.

## Testing

```bash
npm install
npm test
npm run smoke
npm run typecheck
```
