# 智能体与技能

[English](README.md) | 中文

DeepSeek Harness 的侧栏插件：自己造**子智能体**和**技能**，然后在对话里按名字调用子智能体。

面板分左右两栏：

- **子智能体（左）**——一个模型可以派人干活的具名工人：模型服务、思考强度、启动方式（`spawn` 全新对话 / `fork` 继承父对话）、工具清单、绑定的技能。
- **技能（右）**——一份普通的 `SKILL.md` 指令包，带一段模型用来判断触发的描述：可以放全局、按工作区，甚至按单个对话生效。

两个列表都能拖动排序：抓住卡片左侧的六点手柄，上下拖动时卡片之间会撑开一个虚线空位，松手就插到那里；顺序写进插件存储，刷新或重启后保持。

## 依赖

- 带 Web UI 的 DeepSeek Harness（面板是 Client slot 入口）。
- `subagents` 服务与两个本地后端：`@deepseek-ai/dsh-subagent-spawn-in-process`（`spawn`）、`@deepseek-ai/dsh-subagent-fork-in-process`（`fork`）。默认 profile 两个都带。
- 技能文件系统 provider（`@deepseek-ai/dsh-skill-filesystem`），技能才会进入正常的模型目录。

## 安装

在这个目录里把 bundle 装进当前 profile：

```bash
dsh plugin install /absolute/path/to/dsh-agent-skill
```

或者把目录交给 Harness 的插件管理器（`install_bundle`）。bundle 只注册一行 `dsh-agent-skill`，由它挂上 Host 路由和 Client 面板。

装完还要确认这个 bundle 在 `dsh.profile.bundles` 里被选中（`plugin_manager set_bundle`）：只装依赖时侧栏入口会出现，但 Host 半边（路由、`delegate_agent`、技能注入）只有 bundle 行启用才会加载。改了插件自己的 JavaScript 之后需要重启 Harness。

## 使用

### 1. 新建子智能体

左侧栏打开 **Agent & Skill**，在「子智能体」里点 **新建**：

| 字段 | 含义 |
|---|---|
| 名称 | 对话里用它调用。唯一，调用形如 `delegate_agent(agent: "名称", …)`。 |
| 显示名 | 可选，给人看。 |
| 描述 | 可选，会写进工具说明，让模型知道这个工人适合干什么。 |
| 启动方式 | `spawn` 开一段空对话（最省钱，任务要写完整）；`fork` 把父对话已完成的回合带给子智能体（接着当前对话干）。 |
| 模型服务 / 模型 | 可选覆盖；两个都空就跟随当前会话的路由。 |
| 思考强度 | 可选，选项来自模型自己的能力元数据。 |
| 工具清单 | 默认全部工具；勾选后，子智能体看不到清单之外的工具，执行时也会被拦。 |
| 技能 | 勾选的技能会在子智能体开跑前，把整份指令正文注入它的提示词。 |
| 附加指令 | 可选，写这个子智能体的做事习惯。 |

然后在任意对话里直接说，或者让模型自己判断：

```text
把 src/app.ts 的复查派给子智能体「code-reviewer」。
```

模型会调用 `delegate_agent`，通过 `ctx.subagents` 起子会话并拿回它的 session id；子智能体跑完后运行时会通知父会话。

### 2. 新建技能

在「技能」里点 **新建**：

| 字段 | 含义 |
|---|---|
| 技能名 | 与文件目录同名。英文小写字母、数字、连字符（`a-z0-9-`，最长 63）。 |
| 描述 | 必填。模型据此判断何时触发。 |
| 适用场景 | 可选，补充触发条件（写进 `whenToUse`）。 |
| 创建位置 | **全局**——所有工作区可用。**项目**——只在你选的工作区/对话里。 |
| 指令内容 | 模型要照做的正文。 |

项目技能会展开工作区树：

- **下一个新对话也能用（推荐）**——写进 `<项目根>/.dsh/skills/<技能名>/SKILL.md`，项目根是所选工作区最近的 `.git` 祖先（没有则用工作区本身），与正规技能 provider 的发现规则一致；当前和之后这个项目的对话都能用上。
- **只在这些对话里用**——技能留在插件的托管存储里，只通过按 agent 的 system prompt 段落注入给勾选的会话，不碰工作区。

编辑器会在工作区目录位于项目根之下时显示解析出的项目根，并预览真正要写入的文件路径。

### 3. 给子智能体配技能

在子智能体编辑器的「技能」里勾选。派活时 Host 会读每一份 `SKILL.md`，把正文（合计上限 24 000 字符）拼在子智能体提示词前面，再接上任务。

## 数据放在哪

| 数据 | 位置 |
|---|---|
| 子智能体定义 | `<dshHome>/agent-skill/agents.json`（每行带拖拽用的 `order`） |
| 技能绑定 | `<dshHome>/agent-skill/skills.json`（同时保存拖拽 `order` 映射） |
| 按对话生效的技能正文 | `<dshHome>/agent-skill/managed-skills/<技能名>/SKILL.md` |
| 全局技能 | `<dshHome>/skills/<技能名>/SKILL.md`（以及 `<agentsHome>/skills`） |
| 项目技能 | `<项目根>/.dsh/skills/<技能名>/SKILL.md`（最近的 `.git` 祖先） |

这些根目录是 `@deepseek-ai/dsh-skill-filesystem` 扫描全局与项目来源时用的位置（它自己的 custom / bundled 根不在管理范围内），所以写在这里的技能不需要第二个 provider 就能进模型目录。面板也会列出插件之外创建的技能。

## HTTP 接口

所有路由都限制在本机 loopback（或已配对设备）请求，并要求同源浏览器标记：

| 方法 | 路由 | 用途 |
|---|---|---|
| `GET` | `/api/dsh-agent-skill/state` | 子智能体、技能、模型、工具、工作区、会话、路径 |
| `GET` | `/api/dsh-agent-skill/model?provider=&model=` | 某条模型路由的思考强度与上下文窗口 |
| `GET` | `/api/dsh-agent-skill/skill?path=` | 读取托管根目录内的一份 `SKILL.md` |
| `POST` | `/api/dsh-agent-skill/agents/save` | 新建或更新子智能体 |
| `POST` | `/api/dsh-agent-skill/agents/delete` | 删除子智能体 |
| `POST` | `/api/dsh-agent-skill/agents/reorder` | 保存拖拽顺序（`{ ids }`，完整排列） |
| `POST` | `/api/dsh-agent-skill/skills/save` | 写入技能及其绑定 |
| `POST` | `/api/dsh-agent-skill/skills/delete` | 删除技能与插件为它写过的文件 |
| `POST` | `/api/dsh-agent-skill/skills/reorder` | 保存拖拽顺序（`{ names }`，完整排列） |

## 模型侧工具

全局注册一个工具：`delegate_agent`。

```json
{
  "agent": "code-reviewer",
  "description": "复查当前改动",
  "prompt": "给子智能体的完整、自洽的任务。",
  "cwd": "可选的工作目录"
}
```

如实说明的限制：

- `spawn` 子智能体看不到这段对话，任务提示必须自洽；要让子智能体接着已完成的回合干，选 `fork`。
- 每次保存后工具枚举会刷新，新建的子智能体无需重启即可调用；但插件自身 JavaScript 的改动仍需重启 Harness。
- 子智能体的工具清单执行两次约束：`ctx.tools.restrict` 收窄它的作用域（模型看不到越界工具），`ctx.tools.guard` 在执行时兜底拒绝。规则在 activation **之前**预留并持久化，activation 结束后也不撤销，因此续聊的子智能体仍受同一清单约束。
- 传给 `ctx.subagents` 的委派深度会先经过 `subagents.resolveMaxDepth(...)`，所以 profile 里禁用委派的设置优先于定义里的深度。
- 技能正文以提示词注入，单次委派共享 24 000 字符上限；过长会截断并留下标记。
- 单份 `SKILL.md` 上限 48 KiB，每个 frontmatter 字段上限 4 000 字节；编辑器显示字节数，Host 在超限时直接拒绝，不会写出一个 provider 会静默跳过的技能。
- 按对话生效的技能是提示词段落，不是目录项：模型会收到指令，但不会在 `skill` 工具目录里看到它；项目/全局技能则按正常目录被发现。
- 删除技能只删本插件为它写过的文件，以及卡片上显示的那一个文件；其他工作区/根目录的同名技能不会被碰。新建或改名撞上已有名字会返回 `duplicate-skill`。
- 同名技能里项目定义优先于全局，和 provider 的 rank 顺序一致。
- 技能发现只扫一层（`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`），项目根是会话 cwd 最近的 `.git` 祖先——面板写盘时用同一规则。

## 开发

```text
dsh-agent-skill/
├── package.json        bundle 清单（`dsh.bundle.patch`、`dsh.client`）
├── cordis.patch.yml    插入插件行
├── index.js            Host 半边：存储、路由、委派工具、技能注入
├── client.js           Client 半边：侧栏入口 + 双栏面板
├── locale/{en,zh}.json 插件管理器的展示信息
└── icon.svg            原创图标
```

两边都是朴素 JavaScript：没有构建步骤、不重复安装 React、不 import 任何 Harness Client 包。面板只用 `--dsw-alias-*` 主题 token 配色。

Host 半边带一套桩上下文测试，不碰真实 profile：用假 web server、工作区注册表、会话查询、模型注册表和 subagent 注册表驱动 `apply()`，逐项断言路由、技能文件、按对话注入和 `delegate_agent` 的行为。

```bash
npm test          # node --test test/host.test.mjs
```

## 许可

MIT，见 [LICENSE](LICENSE)。
