# Agent & Skill

English | [中文](README.zh.md)

A DeepSeek Harness sidebar plugin for building your own **subagents** and **skills**, then calling any subagent by name in a conversation.

The panel splits into two columns:

- **Subagents (left)** — a named worker the model can delegate to: model route, reasoning effort, launch mode (`spawn` fresh conversation or `fork` inherited conversation), tool allowlist and attached skills.
- **Skills (right)** — an ordinary `SKILL.md` instruction bundle with a description the model can trigger on: global, per workspace, or even per conversation.

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

- **Next new conversation (recommended)** — writes `<workspace>/.dsh/skills/<name>/SKILL.md`, so this and every later conversation in that workspace has it.
- **Only in selected conversations** — keeps the bundle in the plugin's managed store and injects its instructions only into the checked sessions through a per-agent system-prompt section. It does not touch the workspace.

### 3. Attach skills to a subagent

In the subagent editor pick the skills under **Skills**. At delegation time the Host reads each `SKILL.md`, prepends the bodies (capped at 24 000 characters) to the child prompt, and then appends the task.

## Where things live

| Data | Location |
|---|---|
| Subagent definitions | `<dshHome>/agent-skill/agents.json` |
| Skill bindings | `<dshHome>/agent-skill/skills.json` |
| Conversation-scoped skill bodies | `<dshHome>/agent-skill/managed-skills/<name>/SKILL.md` |
| Global skills | `<dshHome>/skills/<name>/SKILL.md` (plus `<agentsHome>/skills`) |
| Project skills | `<workspace>/.dsh/skills/<name>/SKILL.md` |

Those skill roots are exactly the ones `@deepseek-ai/dsh-skill-filesystem` scans, so anything written here reaches agents without a second provider. The panel also lists skills created outside it.

## HTTP surface

All routes are fenced to loopback requests (or a paired device) with same-origin browser markers:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/dsh-agent-skill/state` | Agents, skills, models, tools, workspaces, sessions, paths |
| `GET` | `/api/dsh-agent-skill/model?provider=&model=` | Reasoning efforts and context window for one route |
| `GET` | `/api/dsh-agent-skill/skill?path=` | Read one `SKILL.md` inside a managed root |
| `POST` | `/api/dsh-agent-skill/agents/save` | Create or update a subagent |
| `POST` | `/api/dsh-agent-skill/agents/delete` | Delete a subagent |
| `POST` | `/api/dsh-agent-skill/skills/save` | Write a skill and its bindings |
| `POST` | `/api/dsh-agent-skill/skills/delete` | Delete a skill and the files this plugin wrote for it |

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

Honest limits:

- A `spawn` child does not see this conversation; write the prompt so it stands alone. Use `fork` when the child must build on the finished turns.
- The tool enum refreshes after every save, so a newly created subagent is callable immediately without a restart.
- The child's tool allowlist is enforced twice: `ctx.tools.restrict` on the child scope (the model stops seeing the tools) and a `ctx.tools.guard` denial at execution.
- Skill bodies are injected as prompt text, capped per delegation; a huge `SKILL.md` is truncated with a marker.
- Conversation-scoped skills are prompt sections, not catalog entries: the model receives the instructions but does not see a `skill` tool entry for them. Workspace and global skills are discovered normally.
- Skill discovery is one level deep (`<root>/<name>/SKILL.md` or `<root>/<name>.md`), and the filesystem provider resolves the project root to the nearest `.git` ancestor.

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
