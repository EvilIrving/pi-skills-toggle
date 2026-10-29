# pi-skills-toggle

[English](README_EN.md) | 简体中文

本插件用于在当前项目里排除或恢复全局技能（Skill），不会修改 `~/.pi` 目录中的技能文件，也不会修改全局配置。

术语解释：
- 技能（Skill）：Pi 中供模型调用以完成特定任务的能力包。
- 全局技能：保存在用户主目录或已安装扩展包中的技能，在所有项目里默认均可使用。
- 项目技能：保存在当前项目目录下的技能，仅在当前项目有效。
- 桩文件（Stub）：用于占位的小文件，在本插件中用于覆盖并屏蔽全局技能。
- 终端交互界面（TUI）：在终端窗口中运行的带有键盘交互与可视边框的图形化界面。

## 工作原理

Pi 1.4 通过包管理器解析技能路径，再由 `loadSkills` 按路径优先级加载技能。当存在同名技能时，仅保留最先加载到的技能。

项目目录下的 `.pi/skills` 优先级高于用户目录（`~/.pi`）、agents 目录（`~/.agents`）以及安装包路径。因此，在项目本地创建一个同名的技能，就能覆盖对应的全局技能。

由于 Pi 的 `settings.skills` 路径过滤范围受限于各个配置文件所在的基准目录，项目配置无法直接通过名称禁用用户全局技能。本插件通过在项目目录下写入由本插件管理的桩文件来实现排除：

```text
.pi/skills/<name>/SKILL.md
.pi/skills/<name>/.pi-skills-toggle.json
```

桩文件包含 `disable-model-invocation: true` 配置项（指示模型在组装提示词时不要载入该技能）。在技能名称发生冲突时，项目桩文件因优先级更高而生效，同时该技能不会被加入模型的系统提示词。

例外：手动执行命令 `/skill:<name>` 仍可能存在。

## 安装

全局安装：

```bash
pi install npm:pi-skills-toggle
# 或通过 Git 仓库安装：
pi install git:github.com/EvilIrving/pi-skills-toggle
```

仅在当前项目安装：

```bash
pi install npm:pi-skills-toggle --local
# 或通过 Git 仓库本地安装：
pi install git:github.com/EvilIrving/pi-skills-toggle --local
```

本地目录安装：

```bash
pi install ./path/to/pi-skills-toggle
# 或本地项目安装：
pi install ./path/to/pi-skills-toggle --local
```

安装完成后，重新加载 Pi（执行 `/reload` 或重启终端），然后运行命令：

```text
/skills
```

## 操作方式

本插件仅支持在 Pi 的终端交互界面（TUI 模式）中运行。若在非 TUI 模式下执行，会显示警告提示。

| 按键 | 说明 |
| --- | --- |
| `↑` / `↓` | 移动光标 |
| `空格` | 切换排除或恢复状态（界面提示当前操作；按下后立即写入磁盘） |
| `f` | 轮换筛选范围：全部（All）→ 全局（Global）→ 项目（Project） |
| `/` | 搜索技能 |
| `回车` | 展开或折叠技能描述与文件路径 |
| `r` | 从磁盘重新读取技能列表 |
| `Esc` | 关闭面板 |

列表规则：
- 列表行右侧显示来源：`user`（用户目录）、`agents`（agents 目录）、`package`（已安装包）、`project`（当前项目目录）。
- 已排除的全局技能显示为暗色，并带有红色 `[disabled]` 标记。
- 项目原有的真实技能会被列出，但不可切换，也不会被覆盖。

重要条件：
- 切换排除或恢复状态后，必须运行 `/reload` 或重启 Pi，当前运行的会话才会读取最新的桩文件。

## 安全规则

- 仅创建或更新由本插件管理的两个文件：`SKILL.md` 与 `.pi-skills-toggle.json`。
- 恢复技能时，仅删除上述两个管理文件。仅当技能目录变为空目录时，才会删除该目录。
- 技能目录中若包含非管理文件或子目录（例如 `references/`、`user.txt` 等），绝不进行递归删除，并在界面提示保留的文件列表。
- 仅在桩文件的 SHA-256 哈希值与记录匹配时，才允许删除或覆盖；若桩文件已被修改，则拒绝覆盖或删除。
- 若已存在同名的非管理项目技能，拒绝写入覆盖。
- 技能名称必须是符合规范的小写短横线标识符（slug，即小写字母、数字、单短横线，长度不超过 64 个字符）；且标记文件中的 `name` 必须与所在目录名一致。
- 桩文件路径必须解析在真实的 `.pi/skills` 目录下；若技能目录或文件为软链接（即指向其他路径的快捷方式），拒绝处理。
- 若项目下的 `.pi` 目录为指向外部的软链接，拒绝处理。

## 支持范围

本插件使用 Pi 的 `DefaultPackageManager` 与 `loadSkills` 进行技能发现。

支持的技能路径：
- `~/.pi/agent/skills`
- `~/.agents/skills`
- 项目目录下的 `.pi/skills` 以及父级目录的 `.agents/skills`
- 已配置的 Pi 软件包中的技能（支持 npm、git、本地包）

不支持的范围：
- 不支持 Claude、Codex 等其他工具的技能管理。

## 测试与验证

```bash
npm install
npm test
npm run smoke
npm run typecheck
```
