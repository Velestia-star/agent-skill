# Agent & Skill

English | [中文](README.zh.md)

A DeepSeek Harness sidebar plugin for building your own **subagents** and **skills**, then calling any subagent by name in a conversation.

The panel splits into two columns:

- **Subagents (left)** — a named worker the model can delegate to: model route, reasoning effort, launch mode (`spawn` fresh conversation or `fork` inherited conversation), tool allowlist and attached skills.
- **Skills (right)** — an ordinary `SKILL.md` instruction bundle with a description the model can trigger on: global, per workspace, or even per conversation.

Each column sorts independently: grab the six-dot handle on the left of a card, drag up or down, and a dashed slot opens between the other cards where the item will land. Release to insert it there. Dragging over the other column shows no slot and never changes that column. Moving the pointer out of the list removes the dashed slot and leaves no candidate position: releasing there writes nothing, while moving back inside resumes the same drag. Pressing `Esc`, a `pointercancel`, losing window focus or hiding the page cancels the whole drag and writes nothing. The handle is a real button, so clicking it never opens the card editor. The order is written to the plugin store and survives a refresh or restart.

Every conversation header also carries an **Agent team** button immediately left of the three-dot menu. It opens a lazy, read-only tree rooted at the top-level conversation: branch connector lines, a green running / grey idle dot per node, a `Current` badge, a running/loaded summary, a scrollable body, and a 5-second root refresh. Only the top level is read when the panel opens, so a long-lived conversation opens immediately; each node has an expand control that reads just that branch on demand. Clicking a member opens that conversation. Opening the panel in a subagent conversation expands the path from the root and scrolls to the current member. The panel uses the same menu surface as the built-in subagent catalog.

## Requirements

- DeepSeek Harness with the Web UI (the panel is a Client slot entry).
- The `subagents` service plus both local backends: `@deepseek-ai/dsh-subagent-spawn-in-process` (`spawn`) and `@deepseek-ai/dsh-subagent-fork-in-process` (`fork`). The stock profile ships both.
- The skill filesystem provider (`@deepseek-ai/dsh-skill-filesystem`) for skills to reach agents through the normal catalog.

## Install

From this directory, install the bundle into the active profile:

```bash
dsh plugin install /absolute/path/to/dsh-agent-skill
```

Or hand the directory to the Harness plugin manager (`install_bundle`). The bundle registers one row, `dsh-agent-skill`, which mounts the Host routes and the Client panel.

Make sure the bundle is also selected in `dsh.profile.bundles` (`plugin_manager set_bundle`): an installed dependency alone ships the sidebar entry, but the Host half — routes, `delegate_agent`, skill injection — only loads when the bundle row is enabled. A restart of the Harness is required after changing the plugin's own JavaScript.

## Use it

### 1. Create a subagent

Open **Agent & Skill** in the left sidebar, then **New** under *Subagents*:

| Field | Meaning |
|---|---|
| Name | How you call it in a conversation. Unique, shown as `delegate_agent(agent: "name", …)`. |
| Display name | Optional human label. |
| Description | Optional; it lands in the tool description so the model knows what this worker is for. |
| Launch mode | `spawn` starts an empty conversation (cheapest, task must stand alone). `fork` seeds the child with the parent's finished turns (continues this conversation). |
| Provider / model | Optional override. Leave both empty to inherit the calling session's route. |
| Reasoning effort | Optional; the list comes from the model's own capability metadata. |
| Tool allowlist | All tools by default. A checked list hides everything else from the child model and denies it at execution. |
| Skills | Selected skills are attached: their full instruction bodies are prepended to the child prompt before it starts. |
| Extra instructions | Optional working habits for this subagent. |

Then ask the agent in any conversation, or let the model choose:

```text
Delegate a review of src/app.ts to the subagent "code-reviewer".
```

The model calls `delegate_agent`, which starts the child through `ctx.subagents` and returns its session id; the runtime notifies the parent when the child finishes.

#### Hard trigger: `/chief <task>`

When you want no model judgement at all, type a slash command in the composer:

```text
/chief 把设置页的保存按钮改成 loading 态，只动 src/settings.tsx，回报交付物/证据/遗留
```

`/chief` starts the subagent named `chief` (or its display name / unique prefix) directly from the Host, skips the model turn, and returns a command result with the child session id. The child reports back into this session when it finishes. The command reuses the same skill injection, model route, depth policy and tool allowlist as `delegate_agent`. An empty input returns `用法：/chief <任务>`; a missing agent returns the available names.

### 2. Create a skill

**New** under *Skills*:

| Field | Meaning |
|---|---|
| Skill name | Same as the directory name. Lowercase letters, digits and dashes (`SKILL_NAME_RE`: `a-z0-9-`, max 63). |
| Description | Required. This is what the model triggers on. |
| When to use | Optional extra trigger detail (`whenToUse` frontmatter). |
| Location | **Global** — every workspace. **Project** — the workspaces/conversations you pick. |
| Instructions | The body the model follows. |

Project skills offer a workspace tree:

- **Next new conversation (recommended)** — writes `<projectRoot>/.dsh/skills/<name>/SKILL.md`, where `<projectRoot>` is the nearest `.git` ancestor of the selected workspace (the workspace itself when it has none), matching the rule the shipped skill filesystem provider uses. This and every later conversation in that project has it.
- **Only in selected conversations** — keeps the bundle in the plugin's managed store and injects its instructions only into the checked sessions through a per-agent system-prompt section. It does not touch the workspace.

The editor shows the resolved project root next to a workspace whose directory is below it, and previews the exact file paths it will write.

### 3. Attach skills to a subagent

In the subagent editor pick the skills under **Skills**. At delegation time the Host reads each `SKILL.md`, prepends the bodies (capped at 24 000 characters) to the child prompt, and then appends the task.

## Where things live

| Data | Location |
|---|---|
| Subagent definitions | `<dshHome>/agent-skill/agents.json` — `{ "version": 1, "agents": [...], "rank": [agentId, …] }`; `rank` is the top-level display order, and every write also reorders the `agents` array itself to match it |
| Skill bindings | `<dshHome>/agent-skill/skills.json` — `{ "version": 1, "bindings": {…}, "rank": [skillName, …] }`; `rank` is the top-level display order |
| Conversation-scoped skill bodies | `<dshHome>/agent-skill/managed-skills/<name>/SKILL.md` |
| Global skills | `<dshHome>/skills/<name>/SKILL.md` (plus `<agentsHome>/skills`) |
| Project skills | `<projectRoot>/.dsh/skills/<name>/SKILL.md` (nearest `.git` ancestor) |

Order rules:

- A newly created agent or skill is appended to the end of `rank`.
- Renaming keeps the position: agents use a stable id that does not change on rename, and a skill rename replaces the old name with the new one in place inside `rank`.
- Deleting removes the item from `rank`; every remaining item keeps its relative order.
- If `rank` is missing or invalid (not an array, non-string entries, duplicates, unknown keys), the panel keeps the first occurrence of each valid key and appends every uncovered item in its base order — the `agents` array order for subagents, alphabetical (`localeCompare`) order for skills. The same normalization is applied on read and again before a save, delete or arrange writes the file, so a legacy file is rewritten as a complete order.
- The old per-agent `order` field and the old top-level skill `order` map are ignored. They are not read for sorting and are not migrated; the next write drops them.

Those skill roots are the ones `@deepseek-ai/dsh-skill-filesystem` scans for the global and project sources (its custom and bundled roots are left alone), so anything written here reaches agents without a second provider. The panel also lists skills created outside it.

## HTTP surface

All routes are fenced to loopback requests (or a paired device) with same-origin browser markers:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/dsh-agent-skill/state` | Agents, skills, models, tools, workspaces, sessions, paths |
| `GET` | `/api/dsh-agent-skill/team?sessionId=&parentId=` | One level of the subagent tree plus the root-to-current `trail`; omit `parentId` for the root, pass it to expand a branch |
| `GET` | `/api/dsh-agent-skill/model?provider=&model=` | Reasoning efforts and context window for one route |
| `GET` | `/api/dsh-agent-skill/skill?path=` | Read one `SKILL.md` inside a managed root |
| `POST` | `/api/dsh-agent-skill/agents/save` | Create or update a subagent |
| `POST` | `/api/dsh-agent-skill/agents/delete` | Delete a subagent |
| `POST` | `/api/dsh-agent-skill/agents/arrange` | Persist the subagent order (`{ ids }`, a full permutation of the current agent ids; any other payload is `400 invalid-arrangement`, any other HTTP method is `405`) |
| `POST` | `/api/dsh-agent-skill/skills/save` | Write a skill and its bindings |
| `POST` | `/api/dsh-agent-skill/skills/delete` | Delete a skill and the files this plugin wrote for it |
| `POST` | `/api/dsh-agent-skill/skills/arrange` | Persist the skill order (`{ names }`, a full permutation of the current skill names; any other payload is `400 invalid-arrangement`, any other HTTP method is `405`) |

## Model-facing tool

One tool is registered globally: `delegate_agent`.

```json
{
  "agent": "code-reviewer",
  "description": "review current diff",
  "prompt": "Complete, self-contained task for the child.",
  "cwd": "optional working directory"
}
```

`agent` accepts the configured name, its display name, or a unique prefix of either (`chief` resolves `chief-of-staff`, `幕僚长` resolves the same agent). An ambiguous prefix reports every candidate instead of guessing.

Honest limits:

- A `spawn` child does not see this conversation; write the prompt so it stands alone. Use `fork` when the child must build on the finished turns.
- The tool enum refreshes after every save, so a newly created subagent is callable immediately without a restart. The plugin's own JavaScript changes still need a Harness restart.
- The child's tool allowlist is enforced twice: a `ctx.tools.restrict` scoped to the child (the model stops seeing the tools) and a `ctx.tools.guard` denial at execution. The rule is reserved and persisted **before** activation and kept after the activation settles, so a resumed child keeps the same allowlist.
- The launch depth passed to `ctx.subagents` is resolved through `subagents.resolveMaxDepth(...)`, so a profile that disables delegation still wins over a definition's own limit.
- Skill bodies are injected as prompt text, capped at 24 000 characters per delegation (shared across the attached skills); a huge body is truncated with a marker.
- A `SKILL.md` is limited to 48 KiB and each frontmatter field to 4 000 bytes; the editor counts bytes and the Host rejects an over-limit body instead of writing a skill the provider would silently skip.
- Conversation-scoped skills are prompt sections, not catalog entries: the model receives the instructions but does not see a `skill` tool entry for them. Project and global skills are discovered normally.
- Deleting a skill removes only files this plugin wrote for that skill plus the exact file the card shows; a same-named skill in another workspace or root is left untouched. Creating or renaming onto an existing name is refused with `duplicate-skill`.
- Project definitions outrank global ones by name, matching the provider's rank order.
- Skill discovery is one level deep (`<root>/<name>/SKILL.md` or `<root>/<name>.md`), and a project root is the nearest `.git` ancestor of the session cwd — the panel uses the same rule when it writes.

## Development

```text
dsh-agent-skill/
├── package.json        bundle manifest (`dsh.bundle.patch`, `dsh.client`)
├── cordis.patch.yml    inserts the plugin row
├── index.js            Host half: store, routes, delegate tool, skill injection
├── client.js            Client half: sidebar entry + two-column panel
├── locale/{en,zh}.json  display metadata for Plugin Manager
└── icon.svg             original artwork
```

Both halves are plain JavaScript: no build step, no duplicated React, no Harness Client package imports. The panel styles itself with `--dsw-alias-*` theme tokens only.

The Host half has a stub-context test suite that never touches the real profile: it drives `apply()` with a fake web server, workspace registry, session query, LLM registry and subagent registry, then asserts the routes, skill files, conversation-scoped injection and `delegate_agent` system.

```bash
npm test          # node --test test/host.test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
