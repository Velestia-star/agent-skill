window.__ModuleLoader__.load({
  id: 'dsh-agent-skill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'agent-skill'
    const NS = 'dsh-agent-skill'
    const API_STATE = '/api/dsh-agent-skill/state'
    const API_MODEL = '/api/dsh-agent-skill/model'
    const API_AGENT_SAVE = '/api/dsh-agent-skill/agents/save'
    const API_AGENT_DELETE = '/api/dsh-agent-skill/agents/delete'
    const API_SKILL_SAVE = '/api/dsh-agent-skill/skills/save'
    const API_SKILL_DELETE = '/api/dsh-agent-skill/skills/delete'

    /* ------------------------------------------------------------ locale */

    const ZH = {
      'panel.title': 'Agent & Skill',
      'panel.subtitle': '在这里造子智能体与技能，然后在对话里按名字调用。',
      'panel.agents': '子智能体',
      'panel.skills': '技能',
      'panel.agents.hint': '对话里用 delegate_agent 按名字调用',
      'panel.skills.hint': '子智能体启动前会先读这些指令',
      'panel.callhint': '调用方式',
      'panel.copyHint': '复制',
      'panel.copied': '已复制',
      'panel.refresh': '刷新',
      'panel.loading': '正在读取…',
      'panel.loadingHint': '首次打开需要从 Host 取回子智能体、技能、模型和会话。',
      'panel.error': '读取失败',
      'panel.errorHint': '检查插件是否已启用，然后重试。',
      'panel.retry': '重试',
      'panel.count': '{n} 个',
      'panel.empty.agents': '还没有子智能体。',
      'panel.empty.agentsHint': '新建一个，写清它用什么模型、带哪些技能、能碰哪些工具，对话里就能按名字派活。',
      'panel.empty.skills': '还没有技能。',
      'panel.empty.skillsHint': '技能就是一份 SKILL.md 指令，子智能体运行时会先读它，再干活。',
      'panel.host': 'Host 存储',
      'panel.globalRoot': '全局技能目录',
      'panel.id': 'ID',
      'panel.path': '路径',
      'panel.noSkills': '未绑定技能',
      'panel.allTools': '全部工具',
      'panel.toolCount': '{n} 个工具',
      'panel.usedBy': '被 {n} 个子智能体使用',
      'panel.missingSkill': '技能已不存在',
      'panel.live': '进行中',
      'panel.sessionCount': '{n} 个对话',

      'agent.new': '新建子智能体',
      'agent.edit': '编辑子智能体',
      'agent.field.name': '名称',
      'agent.field.nameHint': '对话里用它调用，唯一',
      'agent.field.namePlaceholder': 'code-reviewer',
      'agent.field.displayName': '显示名',
      'agent.field.displayNameHint': '可选，给人看',
      'agent.field.displayNamePlaceholder': '代码审查',
      'agent.field.description': '描述',
      'agent.field.descriptionHint': '可选，模型决定何时派给它',
      'agent.field.descriptionPlaceholder': '专门复查改动、找回归风险',
      'agent.field.mode': '启动方式',
      'agent.field.modeHint': '决定子智能体拿到什么上下文',
      'agent.field.maxDepth': '最大委派深度',
      'agent.field.maxDepthHint': '0 表示不能再派子智能体',
      'agent.field.provider': '模型服务',
      'agent.field.model': '模型',
      'agent.field.modelHint': '继承＝跟随当前会话',
      'agent.field.effort': '思考强度',
      'agent.field.effortHint': '按任务难度平衡成本',
      'agent.field.effortInherit': '跟随模型默认',
      'agent.field.effortLoading': '读取中…',
      'agent.field.effortUnavailable': '这个模型没有可选强度，按默认跑。',
      'agent.field.tools': '工具清单',
      'agent.field.toolsHint': '勾选后子智能体只能看到这些工具',
      'agent.field.toolsAll': '全部工具（推荐）',
      'agent.field.toolsFilter': '筛选工具…',
      'agent.field.toolsEmpty': '没有匹配的工具',
      'agent.field.skills': '技能',
      'agent.field.skillsHint': '运行前把技能正文注入子智能体',
      'agent.field.skillsEmpty': '还没有技能，先到右边新建一个。',
      'agent.field.skillsMissing': '这个技能已不存在，保存时会保留名字但不注入正文。',
      'agent.field.systemPrompt': '附加指令',
      'agent.field.systemPromptHint': '可选，写在这个子智能体的做事习惯',
      'agent.field.systemPromptPlaceholder': '先读改动，再跑测试，最后给结论……',
      'agent.mode.spawn': 'spawn · 全新对话',
      'agent.mode.spawnHint': '空上下文，任务要写完整。最省钱。',
      'agent.mode.fork': 'fork · 继承父对话',
      'agent.mode.forkHint': '带上当前对话已完成的回合，适合接着干。',
      'agent.model.inherit': '继承当前会话',
      'agent.advanced': '高级',

      'skill.new': '新建技能',
      'skill.edit': '编辑技能',
      'skill.field.name': '技能名',
      'skill.field.nameHint': '与文件目录同名，英文小写 + 连字符',
      'skill.field.namePlaceholder': 'code-review',
      'skill.field.description': '描述',
      'skill.field.descriptionHint': '模型据此判断何时触发',
      'skill.field.descriptionPlaceholder': '按清单复查改动，输出必须修的问题',
      'skill.field.whenToUse': '适用场景',
      'skill.field.whenToUseHint': '可选，补充触发条件',
      'skill.field.whenToUsePlaceholder': '用户要求复查 PR、改动或回归风险时',
      'skill.field.scope': '创建位置',
      'skill.field.scope.global': '全局技能',
      'skill.field.scope.globalHint': '所有工作区的对话都能用',
      'skill.field.scope.project': '项目技能',
      'skill.field.scope.projectHint': '只在你选的工作区/对话里出现',
      'skill.field.workspaces': '工作区与对话',
      'skill.field.workspacesHint': '项目技能至少选一个工作区',
      'skill.field.workspacesEmpty': '左侧栏还没有工作区。',
      'skill.field.content': '指令内容',
      'skill.field.contentHint': '正文，模型按它执行',
      'skill.field.contentPlaceholder': '## 步骤\n1. 先读 diff\n2. 再找回归风险\n3. 输出必须修的问题清单',
      'skill.workspace.nextNew': '下一个新对话也能用（推荐）',
      'skill.workspace.nextNewHint': '写进该工作区的 .dsh/skills，之后的对话都带上。',
      'skill.workspace.sessions': '只在这些对话里用',
      'skill.workspace.sessionsHint': '只注入勾选的对话，不写进工作区。',
      'skill.workspace.sessionsPick': '至少勾选一个对话',
      'skill.workspace.sessionsAll': '全选',
      'skill.workspace.sessionsNone': '该工作区还没有对话',
      'skill.workspace.target': '写入位置',
      'skill.workspace.managed': '托管存储（仅选定对话可见）',
      'skill.scope.globalBadge': '全局',
      'skill.scope.projectBadge': '项目',
      'skill.source.managed': '托管',
      'skill.source.filesystem': '文件',

      'action.new': '新建',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.cancel': '取消',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.confirm': '确认删除',
      'action.expand': '展开',
      'action.collapse': '收起',
      'action.selectAll': '全选',
      'action.clearAll': '清空',

      'error.agent-name-required': '名称不能为空。',
      'error.agent-name-too-long': '名称最长 48 个字符。',
      'error.agent-name-invalid': '名称里不能有斜杠。',
      'error.agent-name-taken': '这个名称已经被别的子智能体用了。',
      'error.invalid-skill-name': '技能名只能用英文小写字母、数字和连字符。',
      'error.description-required': '描述不能为空，模型靠它判断何时触发。',
      'error.workspace-required': '项目技能至少要选一个工作区。',
      'error.model-provider-required': '选了模型就必须同时选模型服务。',
      'error.forbidden': '请求被安全策略拦下了。',
      'error.invalid-json': '请求格式不对。',
      'error.request-failed': '操作失败，稍后再试。',
      'error.offline': 'Host 没有响应。',
      'error.session-required': '至少选一个对话，或改成「下一个新对话」。',
      'error.duplicate-skill': '同名技能已存在。',
      'toast.savedAgent': '子智能体已保存',
      'toast.deletedAgent': '子智能体已删除',
      'toast.savedSkill': '技能已保存',
      'toast.deletedSkill': '技能已删除',
    }

    const EN = {
      'panel.title': 'Agent & Skill',
      'panel.subtitle': 'Build subagents and skills here, then call them by name in a conversation.',
      'panel.agents': 'Subagents',
      'panel.skills': 'Skills',
      'panel.agents.hint': 'Call one with delegate_agent',
      'panel.skills.hint': 'Read before a subagent starts',
      'panel.callhint': 'Call',
      'panel.copyHint': 'Copy',
      'panel.copied': 'Copied',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Loading…',
      'panel.loadingHint': 'The panel is reading subagents, skills, models and sessions from the Host.',
      'panel.error': 'Could not load',
      'panel.errorHint': 'Check that the plugin is enabled, then retry.',
      'panel.retry': 'Retry',
      'panel.count': '{n}',
      'panel.empty.agents': 'No subagents yet.',
      'panel.empty.agentsHint': 'Create one: pick its model, skills and tools, then delegate to it by name.',
      'panel.empty.skills': 'No skills yet.',
      'panel.empty.skillsHint': 'A skill is a SKILL.md instruction bundle a subagent reads before it works.',
      'panel.host': 'Host store',
      'panel.globalRoot': 'Global skills',
      'panel.id': 'ID',
      'panel.path': 'Path',
      'panel.noSkills': 'No skills',
      'panel.allTools': 'All tools',
      'panel.toolCount': '{n} tools',
      'panel.usedBy': 'Used by {n} subagents',
      'panel.missingSkill': 'Missing skill',
      'panel.live': 'live',
      'panel.sessionCount': '{n} conversations',

      'agent.new': 'New subagent',
      'agent.edit': 'Edit subagent',
      'agent.field.name': 'Name',
      'agent.field.nameHint': 'Used to call it, must be unique',
      'agent.field.namePlaceholder': 'code-reviewer',
      'agent.field.displayName': 'Display name',
      'agent.field.displayNameHint': 'Optional',
      'agent.field.displayNamePlaceholder': 'Code review',
      'agent.field.description': 'Description',
      'agent.field.descriptionHint': 'Helps the model decide when to delegate',
      'agent.field.descriptionPlaceholder': 'Reviews changes for regressions',
      'agent.field.mode': 'Launch mode',
      'agent.field.modeHint': 'What context the child receives',
      'agent.field.maxDepth': 'Max delegation depth',
      'agent.field.maxDepthHint': '0 means it cannot delegate further',
      'agent.field.provider': 'Provider',
      'agent.field.model': 'Model',
      'agent.field.modelHint': 'Inherit follows this session',
      'agent.field.effort': 'Reasoning effort',
      'agent.field.effortHint': 'Balance cost against quality',
      'agent.field.effortInherit': 'Model default',
      'agent.field.effortLoading': 'Reading…',
      'agent.field.effortUnavailable': 'This model has no selectable effort; it runs on its default.',
      'agent.field.tools': 'Tool allowlist',
      'agent.field.toolsHint': 'The child only sees the checked tools',
      'agent.field.toolsAll': 'All tools (recommended)',
      'agent.field.toolsFilter': 'Filter tools…',
      'agent.field.toolsEmpty': 'No matching tool',
      'agent.field.skills': 'Skills',
      'agent.field.skillsHint': 'Skill bodies are injected before the child works',
      'agent.field.skillsEmpty': 'No skills yet. Create one on the right.',
      'agent.field.skillsMissing': 'This skill no longer exists; its name is kept but no body is injected.',
      'agent.field.systemPrompt': 'Extra instructions',
      'agent.field.systemPromptHint': 'Optional working habits for this subagent',
      'agent.field.systemPromptPlaceholder': 'Read the diff first, then run tests, then conclude…',
      'agent.mode.spawn': 'spawn · fresh',
      'agent.mode.spawnHint': 'Empty context; the task must stand alone. Cheapest.',
      'agent.mode.fork': 'fork · inherit',
      'agent.mode.forkHint': 'Seeded with this conversation’s finished turns.',
      'agent.model.inherit': 'Inherit current session',
      'agent.advanced': 'Advanced',

      'skill.new': 'New skill',
      'skill.edit': 'Edit skill',
      'skill.field.name': 'Skill name',
      'skill.field.nameHint': 'Same as its directory; lowercase and dashes',
      'skill.field.namePlaceholder': 'code-review',
      'skill.field.description': 'Description',
      'skill.field.descriptionHint': 'How the model decides to trigger it',
      'skill.field.descriptionPlaceholder': 'Review a change against a checklist',
      'skill.field.whenToUse': 'When to use',
      'skill.field.whenToUseHint': 'Optional trigger detail',
      'skill.field.whenToUsePlaceholder': 'When the user asks for a review',
      'skill.field.scope': 'Location',
      'skill.field.scope.global': 'Global skill',
      'skill.field.scope.globalHint': 'Available in every workspace',
      'skill.field.scope.project': 'Project skill',
      'skill.field.scope.projectHint': 'Only where you select',
      'skill.field.workspaces': 'Workspaces & conversations',
      'skill.field.workspacesHint': 'A project skill needs at least one workspace',
      'skill.field.workspacesEmpty': 'No workspace in the sidebar yet.',
      'skill.field.content': 'Instructions',
      'skill.field.contentHint': 'The body the model follows',
      'skill.field.contentPlaceholder': '## Steps\n1. Read the diff\n2. Look for regressions\n3. List must-fix items',
      'skill.workspace.nextNew': 'Also in the next new conversation (recommended)',
      'skill.workspace.nextNewHint': 'Writes into that workspace’s .dsh/skills.',
      'skill.workspace.sessions': 'Only in selected conversations',
      'skill.workspace.sessionsHint': 'Injected only into the checked conversations.',
      'skill.workspace.sessionsPick': 'Check at least one conversation',
      'skill.workspace.sessionsAll': 'Select all',
      'skill.workspace.sessionsNone': 'No conversation in this workspace yet',
      'skill.workspace.target': 'Writes to',
      'skill.workspace.managed': 'Managed store (only the selected conversations)',
      'skill.scope.globalBadge': 'global',
      'skill.scope.projectBadge': 'project',
      'skill.source.managed': 'managed',
      'skill.source.filesystem': 'file',

      'action.new': 'New',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.cancel': 'Cancel',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.confirm': 'Confirm delete',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'action.selectAll': 'Select all',
      'action.clearAll': 'Clear',

      'error.agent-name-required': 'The name cannot be empty.',
      'error.agent-name-too-long': 'The name is limited to 48 characters.',
      'error.agent-name-invalid': 'The name cannot contain slashes.',
      'error.agent-name-taken': 'Another subagent already uses this name.',
      'error.invalid-skill-name': 'Use lowercase letters, digits and dashes only.',
      'error.description-required': 'A description is required; the model triggers on it.',
      'error.workspace-required': 'Pick at least one workspace.',
      'error.model-provider-required': 'A model needs its provider.',
      'error.forbidden': 'The request was blocked by the security fence.',
      'error.invalid-json': 'The request was malformed.',
      'error.request-failed': 'The operation failed; try again.',
      'error.offline': 'The Host did not respond.',
      'error.session-required': 'Pick at least one conversation, or switch to the next new conversation.',
      'error.duplicate-skill': 'A skill with that name already exists.',
      'toast.savedAgent': 'Subagent saved',
      'toast.deletedAgent': 'Subagent deleted',
      'toast.savedSkill': 'Skill saved',
      'toast.deletedSkill': 'Skill deleted',
    }

    function makeTranslator(locale) {
      return function t(key, vars) {
        let text
        try {
          if (locale !== undefined && typeof locale.translate === 'function') text = locale.translate(key)
        } catch {
          text = undefined
        }
        if (typeof text !== 'string' || text === '' || text === key) {
          const dict = currentLocaleIsZh ? ZH : EN
          text = dict[key] ?? ZH[key] ?? EN[key] ?? key
        }
        if (vars && typeof vars === 'object') {
          return String(text).replace(/\{(\w+)\}/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
          )
        }
        return String(text)
      }
    }

    let currentLocaleIsZh = true
    let translate = makeTranslator(undefined)
    const t = (key, vars) => translate(key, vars)

    function detectZh() {
      try {
        return (navigator.language || '').toLowerCase().startsWith('zh')
      } catch {
        return true
      }
    }
    currentLocaleIsZh = detectZh()

    /* ------------------------------------------------------------- helpers */

    function classNames() {
      return Array.prototype.filter.call(arguments, Boolean).join(' ')
    }

    function formatCount(template, count) {
      return String(template).replace('{n}', String(count))
    }

    function samePath(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false
      return a.toLowerCase() === b.toLowerCase()
    }

    function shortPath(value, max) {
      if (typeof value !== 'string' || value === '') return ''
      const limit = typeof max === 'number' ? max : 48
      if (value.length <= limit) return value
      return '…' + value.slice(value.length - limit + 1)
    }

    function describeError(error) {
      const raw = error instanceof Error ? error.message : String(error ?? '')
      const key = `error.${raw}`
      const text = t(key)
      if (text !== key) return text
      if (/^Failed to fetch|NetworkError|Load failed/i.test(raw)) return t('error.offline')
      return raw === '' ? t('error.request-failed') : raw
    }

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `http-${response.status}`)
      return payload
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error || `http-${response.status}`)
      return payload
    }

    /* ----------------------------------------------------------------- icon */

    function icon(name, size) {
      const edge = typeof size === 'number' ? size : 14
      const common = {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      const paths = {
        plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
        refresh: [
          h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.6-5.9' }),
          h('path', { key: 'b', d: 'M20 4v5h-5' }),
        ],
        edit: [
          h('path', { key: 'a', d: 'M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z' }),
          h('path', { key: 'b', d: 'M13.5 7.5l3 3' }),
        ],
        trash: [
          h('path', { key: 'a', d: 'M4 7h16' }),
          h('path', { key: 'b', d: 'M9 7V5h6v2' }),
          h('path', { key: 'c', d: 'M6.5 7l.8 12h9.4l.8-12' }),
        ],
        close: [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })],
        chevron: [h('path', { key: 'a', d: 'M9 6l6 6-6 6' })],
        check: [h('path', { key: 'a', d: 'M5 12.5l4.5 4.5L19 7' })],
        copy: [
          h('rect', { key: 'a', x: '9', y: '9', width: '11', height: '11', rx: '2' }),
          h('path', { key: 'b', d: 'M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15' }),
        ],
        bot: [
          h('rect', { key: 'a', x: '4', y: '8', width: '16', height: '11', rx: '3' }),
          h('path', { key: 'b', d: 'M12 4v4' }),
          h('circle', { key: 'c', cx: '9', cy: '13', r: '1' }),
          h('circle', { key: 'd', cx: '15', cy: '13', r: '1' }),
        ],
        book: [
          h('path', { key: 'a', d: 'M5 5.5A1.5 1.5 0 0 1 6.5 4H19v16H6.5A1.5 1.5 0 0 0 5 21.5Z' }),
          h('path', { key: 'b', d: 'M8 8h7M8 12h7' }),
        ],
        dot: [h('circle', { key: 'a', cx: '12', cy: '12', r: '4', fill: 'currentColor', stroke: 'none' })],
      }
      return h('svg', common, paths[name] ?? paths.dot)
    }

    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { opacity: props?.active === false ? 0.82 : 1 },
        },
        h('rect', { key: 'l', x: '2.6', y: '7.5', width: '7.2', height: '9', rx: '2.2' }),
        h('path', { key: 'c', d: 'M9.8 12h4.4' }),
        h('path', { key: 'r', d: 'M14.2 6.4h5.2A2.2 2.2 0 0 1 21.6 8.6v6.8a2.2 2.2 0 0 1-2.2 2.2h-5.2z' }),
        h('path', { key: 'b1', d: 'M16.4 10.2h3.2M16.4 13.2h3.2' }),
      )
    }

    /* -------------------------------------------------------------- controls */

    function Button(props) {
      const { tone, iconName, label, onClick, disabled, title, wide } = props
      return h(
        'button',
        {
          type: 'button',
          className: classNames('asa-btn', wide ? 'asa-btn-wide' : ''),
          'data-tone': tone,
          title: title ?? label,
          'aria-label': title ?? label,
          disabled: disabled === true,
          onClick,
        },
        iconName ? icon(iconName, 13) : null,
        label ? h('span', null, label) : null,
      )
    }

    function IconButton(props) {
      const { iconName, label, onClick, tone, disabled } = props
      return h(
        'button',
        {
          type: 'button',
          className: 'asa-icon-btn',
          'data-tone': tone,
          title: label,
          'aria-label': label,
          disabled: disabled === true,
          onClick,
        },
        icon(iconName, 13),
      )
    }

    function Badge(props) {
      return h(
        'span',
        { className: 'asa-badge', 'data-tone': props.tone, title: props.title },
        props.iconName ? icon(props.iconName, 11) : null,
        props.children,
      )
    }

    function Field(props) {
      return h(
        'div',
        { className: classNames('asa-field', props.className) },
        h(
          'div',
          { className: 'asa-field-head' },
          h(
            'span',
            { className: 'asa-field-label' },
            props.label,
            props.required ? h('span', { className: 'asa-req', 'aria-hidden': 'true' }, ' *') : null,
          ),
          props.hint ? h('span', { className: 'asa-field-hint' }, props.hint) : null,
        ),
        props.children,
      )
    }

    function TextInput(props) {
      const { value, onChange, placeholder, mono, disabled, id, onKeyDown } = props
      return h('input', {
        id,
        type: 'text',
        className: classNames('asa-input', mono ? 'asa-mono' : ''),
        value: value ?? '',
        placeholder,
        disabled: disabled === true,
        spellCheck: false,
        autoComplete: 'off',
        onKeyDown,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function NumberInput(props) {
      const { value, onChange, min, max, id } = props
      return h('input', {
        id,
        type: 'number',
        className: 'asa-input asa-input-num',
        value: value ?? 0,
        min,
        max,
        onChange: (event) => {
          const next = Number(event.target.value)
          onChange(Number.isFinite(next) ? next : 0)
        },
      })
    }

    function TextArea(props) {
      const { value, onChange, placeholder, rows, mono, id } = props
      return h('textarea', {
        id,
        className: classNames('asa-input asa-textarea', mono ? 'asa-mono' : ''),
        value: value ?? '',
        placeholder,
        rows: rows ?? 4,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function Select(props) {
      const { value, onChange, options, disabled, id } = props
      return h(
        'select',
        {
          id,
          className: 'asa-input asa-select',
          value: value ?? '',
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.value),
        },
        (options || []).map((option) =>
          h('option', { key: option.value, value: option.value }, option.label),
        ),
      )
    }

    function Check(props) {
      const { checked, onChange, label, detail, disabled } = props
      return h(
        'label',
        { className: classNames('asa-check', disabled ? 'asa-check-disabled' : '') },
        h('input', {
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h(
          'span',
          { className: 'asa-check-body' },
          h('span', { className: 'asa-check-label' }, label),
          detail ? h('span', { className: 'asa-check-detail' }, detail) : null,
        ),
      )
    }

    function Segmented(props) {
      return h(
        'div',
        { className: 'asa-seg', role: 'radiogroup', 'aria-label': props.label },
        (props.options || []).map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'radio',
              'aria-checked': props.value === option.value,
              className: 'asa-seg-btn',
              'data-active': props.value === option.value ? 'true' : 'false',
              onClick: () => props.onChange(option.value),
            },
            h('span', { className: 'asa-seg-title' }, option.label),
            option.hint ? h('span', { className: 'asa-seg-hint' }, option.hint) : null,
          ),
        ),
      )
    }

    function ChipList(props) {
      const { items, empty, tone } = props
      if (!items || items.length === 0) {
        return empty ? h('span', { className: 'asa-dim' }, empty) : null
      }
      return h(
        'div',
        { className: 'asa-chips' },
        items.map((item) =>
          h(
            'span',
            {
              key: item.key ?? item.label,
              className: 'asa-chip',
              'data-tone': item.tone ?? tone,
              title: item.title,
            },
            item.label,
          ),
        ),
      )
    }

    function Spinner() {
      return h('span', { className: 'asa-spinner', 'aria-hidden': 'true' })
    }

    /* -------------------------------------------------------------- host data */

    function useHostState() {
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const abortRef = useRef(null)

      const load = useCallback(async () => {
        try {
          abortRef.current?.abort()
        } catch {
          /* ignore */
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abortRef.current = controller
        setState((previous) => ({
          status: previous.data ? 'refreshing' : 'loading',
          data: previous.data,
          error: null,
        }))
        try {
          const response = await fetch(API_STATE, {
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error || `http-${response.status}`)
          setState({ status: 'ready', data: payload, error: null })
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') return
          setState((previous) => ({ status: 'error', data: previous.data, error }))
        }
      }, [])

      useEffect(() => {
        load()
        return () => {
          try {
            abortRef.current?.abort()
          } catch {
            /* ignore */
          }
        }
      }, [load])

      return { ...state, reload: load }
    }

    function useModelEfforts(provider, model) {
      const [result, setResult] = useState({ status: 'idle', efforts: [] })
      useEffect(() => {
        if (provider === '' || model === '') {
          setResult({ status: 'idle', efforts: [] })
          return undefined
        }
        let cancelled = false
        setResult({ status: 'loading', efforts: [] })
        getJson(`${API_MODEL}?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`)
          .then((payload) => {
            if (cancelled) return
            setResult({
              status: 'ready',
              efforts: Array.isArray(payload.efforts) ? payload.efforts : [],
              defaultEffort: payload.defaultEffort,
              contextWindow: payload.contextWindow,
              error: payload.error,
            })
          })
          .catch((error) => {
            if (cancelled) return
            setResult({ status: 'error', efforts: [], error })
          })
        return () => {
          cancelled = true
        }
      }, [provider, model])
      return result
    }

    /* ---------------------------------------------------------- agent editor */

    function emptyAgentDraft() {
      return {
        id: undefined,
        name: '',
        displayName: '',
        description: '',
        systemPrompt: '',
        mode: 'spawn',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxDepth: 1,
        tools: null,
        skills: [],
      }
    }

    function agentDraftOf(agent) {
      if (!agent) return emptyAgentDraft()
      return {
        id: agent.id,
        name: agent.name ?? '',
        displayName: agent.displayName ?? '',
        description: agent.description ?? '',
        systemPrompt: agent.systemPrompt ?? '',
        mode: agent.mode === 'fork' ? 'fork' : 'spawn',
        provider: agent.provider ?? '',
        model: agent.model ?? '',
        reasoningEffort: agent.reasoningEffort ?? '',
        maxDepth: Number.isFinite(agent.maxDepth) ? agent.maxDepth : 1,
        tools: Array.isArray(agent.tools) && agent.tools.length > 0 ? agent.tools.slice() : null,
        skills: Array.isArray(agent.skills) ? agent.skills.slice() : [],
      }
    }

    function AgentEditor(props) {
      const { data, draft, onChange, onSave, onCancel, busy, error } = props
      const [toolFilter, setToolFilter] = useState('')
      const [showAdvanced, setShowAdvanced] = useState(false)
      const efforts = useModelEfforts(draft.provider, draft.model)

      const providers = data.models || []
      const providerModels = useMemo(() => {
        const found = providers.find((provider) => provider.id === draft.provider)
        return found ? found.models : []
      }, [providers, draft.provider])

      const allTools = draft.tools === null
      const selectedTools = allTools ? [] : draft.tools
      const filteredTools = useMemo(() => {
        const query = toolFilter.trim().toLowerCase()
        const tools = data.tools || []
        if (query === '') return tools
        return tools.filter((name) => name.toLowerCase().includes(query))
      }, [data.tools, toolFilter])

      const skillOptions = data.skills || []

      const set = (patch) => onChange({ ...draft, ...patch })

      const toggleTool = (name) => {
        const current = allTools ? [] : selectedTools.slice()
        const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
        set({ tools: next.length === 0 ? null : next })
      }

      const toggleSkill = (name) => {
        const current = draft.skills.slice()
        set({
          skills: current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
        })
      }

      const effortOptions = useMemo(() => {
        const options = [{ value: '', label: t('agent.field.effortInherit') }]
        for (const effort of efforts.efforts || []) {
          options.push({ value: effort.id, label: effort.name || effort.id })
        }
        if (draft.reasoningEffort !== '' && !options.some((option) => option.value === draft.reasoningEffort)) {
          options.push({ value: draft.reasoningEffort, label: draft.reasoningEffort })
        }
        return options
      }, [efforts, draft.reasoningEffort])

      const effortHint = (() => {
        if (draft.model === '') return t('agent.field.effortHint')
        if (efforts.status === 'loading') return t('agent.field.effortLoading')
        if (efforts.status === 'ready' && (efforts.efforts || []).length === 0) {
          return t('agent.field.effortUnavailable')
        }
        if (efforts.status === 'error') return t('agent.field.effortUnavailable')
        return t('agent.field.effortHint')
      })()

      return h(
        'div',
        { className: 'asa-form' },
        error ? h('div', { className: 'asa-form-error', role: 'alert' }, error) : null,

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('agent.field.name'), hint: t('agent.field.nameHint'), required: true },
            h(TextInput, {
              value: draft.name,
              mono: true,
              placeholder: t('agent.field.namePlaceholder'),
              onChange: (value) => set({ name: value }),
            }),
          ),
          h(Field, { label: t('agent.field.displayName'), hint: t('agent.field.displayNameHint') },
            h(TextInput, {
              value: draft.displayName,
              placeholder: t('agent.field.displayNamePlaceholder'),
              onChange: (value) => set({ displayName: value }),
            }),
          ),
          h(Field, { label: t('agent.field.description'), hint: t('agent.field.descriptionHint') },
            h(TextArea, {
              value: draft.description,
              rows: 2,
              placeholder: t('agent.field.descriptionPlaceholder'),
              onChange: (value) => set({ description: value }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('agent.field.mode'), hint: t('agent.field.modeHint') },
            h(Segmented, {
              label: t('agent.field.mode'),
              value: draft.mode,
              onChange: (value) => set({ mode: value }),
              options: [
                { value: 'spawn', label: t('agent.mode.spawn'), hint: t('agent.mode.spawnHint') },
                { value: 'fork', label: t('agent.mode.fork'), hint: t('agent.mode.forkHint') },
              ],
            }),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('agent.field.provider') },
            h(Select, {
              value: draft.provider,
              onChange: (value) => set({ provider: value, model: '', reasoningEffort: '' }),
              options: [
                { value: '', label: t('agent.model.inherit') },
                ...providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name || provider.id,
                })),
              ],
            }),
          ),
          h(Field, { label: t('agent.field.model'), hint: t('agent.field.modelHint') },
            h(Select, {
              value: draft.model,
              disabled: draft.provider === '',
              onChange: (value) => set({ model: value, reasoningEffort: '' }),
              options: [
                { value: '', label: t('agent.model.inherit') },
                ...providerModels.map((model) => ({
                  value: model.id,
                  label: model.name || model.id,
                })),
              ],
            }),
          ),
          h(Field, { label: t('agent.field.effort'), hint: effortHint },
            h(Select, {
              value: draft.reasoningEffort,
              disabled: draft.model === '' || (efforts.status === 'ready' && (efforts.efforts || []).length === 0),
              onChange: (value) => set({ reasoningEffort: value }),
              options: effortOptions,
            }),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('agent.field.tools'), hint: t('agent.field.toolsHint') },
            h(Check, {
              checked: allTools,
              label: t('agent.field.toolsAll'),
              onChange: (checked) => set({ tools: checked ? null : [] }),
            }),
            allTools
              ? null
              : h(
                  'div',
                  { className: 'asa-multi' },
                  h('div', { className: 'asa-multi-head' },
                    h(TextInput, {
                      value: toolFilter,
                      placeholder: t('agent.field.toolsFilter'),
                      onChange: setToolFilter,
                    }),
                    h(Button, {
                      tone: 'ghost',
                      label: t('action.clearAll'),
                      onClick: () => set({ tools: null }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'asa-multi-list' },
                    filteredTools.length === 0
                      ? h('div', { className: 'asa-dim' }, t('agent.field.toolsEmpty'))
                      : filteredTools.map((name) =>
                          h(Check, {
                            key: name,
                            checked: selectedTools.includes(name),
                            label: name,
                            onChange: () => toggleTool(name),
                          }),
                        ),
                  ),
                ),
          ),
          h(Field, { label: t('agent.field.skills'), hint: t('agent.field.skillsHint') },
            skillOptions.length === 0
              ? h('div', { className: 'asa-dim' }, t('agent.field.skillsEmpty'))
              : h(
                  'div',
                  { className: 'asa-multi' },
                  h(
                    'div',
                    { className: 'asa-multi-list asa-multi-tall' },
                    skillOptions.map((skill) =>
                      h(Check, {
                        key: skill.name,
                        checked: draft.skills.includes(skill.name),
                        label: skill.name,
                        detail: skill.description,
                        onChange: () => toggleSkill(skill.name),
                      }),
                    ),
                  ),
                ),
            draft.skills.some((name) => !skillOptions.some((skill) => skill.name === name))
              ? h('div', { className: 'asa-warn' }, t('agent.field.skillsMissing'))
              : null,
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(
            'button',
            {
              type: 'button',
              className: 'asa-disclosure',
              onClick: () => setShowAdvanced(!showAdvanced),
              'aria-expanded': showAdvanced,
            },
            h('span', { className: classNames('asa-disclosure-mark', showAdvanced ? 'asa-open' : '') }, icon('chevron', 12)),
            t('agent.advanced'),
          ),
          showAdvanced
            ? [
                h(Field, { key: 'depth', label: t('agent.field.maxDepth'), hint: t('agent.field.maxDepthHint') },
                  h(NumberInput, {
                    value: draft.maxDepth,
                    min: 0,
                    max: 6,
                    onChange: (value) => set({ maxDepth: Math.max(0, Math.min(6, value)) }),
                  }),
                ),
                h(Field, { key: 'prompt', label: t('agent.field.systemPrompt'), hint: t('agent.field.systemPromptHint') },
                  h(TextArea, {
                    value: draft.systemPrompt,
                    rows: 4,
                    placeholder: t('agent.field.systemPromptPlaceholder'),
                    onChange: (value) => set({ systemPrompt: value }),
                  }),
                ),
              ]
            : null,
        ),

        h(
          'div',
          { className: 'asa-form-actions' },
          h(Button, { tone: 'primary', label: busy ? t('action.saving') : t('action.save'), onClick: onSave, disabled: busy }),
          h(Button, { label: t('action.cancel'), onClick: onCancel, disabled: busy }),
        ),
      )
    }

    /* ---------------------------------------------------------- skill editor */

    function emptySkillDraft() {
      return {
        originalName: '',
        name: '',
        description: '',
        whenToUse: '',
        content: '',
        scope: 'global',
        workspaces: [],
      }
    }

    function workspaceValueOf(skill, workspaces) {
      const rows = []
      const bindingWorkspaces = skill?.binding?.workspaces ?? []
      for (const workspace of workspaces || []) {
        const existing = bindingWorkspaces.find((entry) => samePath(entry.path, workspace.path))
        rows.push({
          path: workspace.path,
          title: workspace.title,
          included: existing !== undefined,
          mode: existing?.mode === 'sessions' ? 'sessions' : 'workspace',
          sessions: existing?.sessions ? existing.sessions.slice() : [],
          expanded: false,
        })
      }
      return rows
    }

    function skillDraftOf(skill, workspaces) {
      if (!skill) {
        const draft = emptySkillDraft()
        draft.workspaces = workspaceValueOf(undefined, workspaces)
        return draft
      }
      return {
        originalName: skill.name,
        name: skill.name,
        description: skill.description ?? '',
        whenToUse: skill.whenToUse ?? '',
        content: skill.content ?? '',
        scope: skill.scope === 'global' ? 'global' : 'project',
        workspaces: workspaceValueOf(skill, workspaces),
      }
    }

    function WorkspacePicker(props) {
      const { data, rows, onChange } = props
      const sessionsByWorkspace = useMemo(() => {
        const map = new Map()
        for (const session of data.sessions || []) {
          if (typeof session.workspacePath !== 'string' || session.workspacePath === '') continue
          const key = session.workspacePath.toLowerCase()
          const list = map.get(key) || []
          list.push(session)
          map.set(key, list)
        }
        return map
      }, [data.sessions])

      const patchRow = (index, patch) => {
        onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
      }

      const sessionsOf = (row) => sessionsByWorkspace.get(row.path.toLowerCase()) || []

      if (rows.length === 0) return h('div', { className: 'asa-dim' }, t('skill.field.workspacesEmpty'))

      return h(
        'div',
        { className: 'asa-ws' },
        rows.map((row, index) => {
          const sessions = sessionsOf(row)
          const selectedCount = row.sessions.length
          return h(
            'div',
            { key: row.path, className: 'asa-ws-row', 'data-included': row.included ? 'true' : 'false' },
            h(
              'div',
              { className: 'asa-ws-head' },
              h(Check, {
                checked: row.included,
                label: row.title || row.path,
                detail: shortPath(row.path, 42),
                onChange: (checked) =>
                  patchRow(index, {
                    included: checked,
                    mode: checked && row.mode !== 'sessions' ? 'workspace' : row.mode,
                  }),
              }),
              h(
                'div',
                { className: 'asa-ws-tools' },
                h(
                  'span',
                  { className: 'asa-dim asa-ws-count' },
                  formatCount(t('panel.sessionCount'), sessions.length),
                ),
                row.included
                  ? h(IconButton, {
                      iconName: 'chevron',
                      label: row.expanded ? t('action.collapse') : t('action.expand'),
                      onClick: () => patchRow(index, { expanded: !row.expanded }),
                    })
                  : null,
              ),
            ),
            row.included && row.expanded
              ? h(
                  'div',
                  { className: 'asa-ws-body' },
                  h(Segmented, {
                    label: t('skill.field.workspaces'),
                    value: row.mode,
                    onChange: (value) => patchRow(index, { mode: value }),
                    options: [
                      { value: 'workspace', label: t('skill.workspace.nextNew'), hint: t('skill.workspace.nextNewHint') },
                      { value: 'sessions', label: t('skill.workspace.sessions'), hint: t('skill.workspace.sessionsHint') },
                    ],
                  }),
                  row.mode === 'sessions'
                    ? sessions.length === 0
                      ? h('div', { className: 'asa-warn' }, t('skill.workspace.sessionsNone'))
                      : h(
                          'div',
                          { className: 'asa-multi asa-multi-sessions' },
                          h(
                            'div',
                            { className: 'asa-multi-head' },
                            h('span', { className: 'asa-dim' },
                              formatCount(t('panel.count'), selectedCount)),
                            h(Button, {
                              tone: 'ghost',
                              label: t('skill.workspace.sessionsAll'),
                              onClick: () =>
                                patchRow(index, {
                                  sessions:
                                    selectedCount === sessions.length
                                      ? []
                                      : sessions.map((session) => session.id),
                                }),
                            }),
                          ),
                          h(
                            'div',
                            { className: 'asa-multi-list asa-multi-tall' },
                            sessions.map((session) =>
                              h(Check, {
                                key: session.id,
                                checked: row.sessions.includes(session.id),
                                label: session.title || session.id.slice(0, 8),
                                detail: session.id,
                                onChange: (checked) =>
                                  patchRow(index, {
                                    sessions: checked
                                      ? [...row.sessions, session.id]
                                      : row.sessions.filter((id) => id !== session.id),
                                  }),
                              }),
                            ),
                          ),
                        )
                    : null,
                  row.mode === 'sessions' && row.sessions.length === 0
                    ? h('div', { className: 'asa-warn' }, t('skill.workspace.sessionsPick'))
                    : null,
                )
              : null,
          )
        }),
      )
    }

    function SkillEditor(props) {
      const { data, draft, onChange, onSave, onCancel, busy, error } = props
      const set = (patch) => onChange({ ...draft, ...patch })

      const setScope = (scope) => {
        if (scope === draft.scope) return
        if (scope === 'project' && !draft.workspaces.some((row) => row.included) && draft.workspaces.length > 0) {
          set({
            scope,
            workspaces: draft.workspaces.map((row, index) =>
              index === 0 ? { ...row, included: true, expanded: true, mode: 'workspace' } : row,
            ),
          })
          return
        }
        set({ scope })
      }

      const targets = useMemo(() => {
        const name = draft.name.trim() || '<name>'
        if (draft.scope === 'global') {
          const root = data.paths?.globalSkills || '~/.dsh/skills'
          return [`${root}/${name}/SKILL.md`]
        }
        const list = []
        for (const row of draft.workspaces.filter((entry) => entry.included)) {
          if (row.mode === 'workspace') list.push(`${row.path}/.dsh/skills/${name}/SKILL.md`)
          else list.push(t('skill.workspace.managed'))
        }
        return list
      }, [data.paths, draft.name, draft.scope, draft.workspaces])

      return h(
        'div',
        { className: 'asa-form' },
        error ? h('div', { className: 'asa-form-error', role: 'alert' }, error) : null,

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('skill.field.name'), hint: t('skill.field.nameHint'), required: true },
            h(TextInput, {
              value: draft.name,
              mono: true,
              placeholder: t('skill.field.namePlaceholder'),
              onChange: (value) => set({ name: value }),
            }),
          ),
          h(Field, { label: t('skill.field.description'), hint: t('skill.field.descriptionHint'), required: true },
            h(TextArea, {
              value: draft.description,
              rows: 2,
              placeholder: t('skill.field.descriptionPlaceholder'),
              onChange: (value) => set({ description: value }),
            }),
          ),
          h(Field, { label: t('skill.field.whenToUse'), hint: t('skill.field.whenToUseHint') },
            h(TextArea, {
              value: draft.whenToUse,
              rows: 2,
              placeholder: t('skill.field.whenToUsePlaceholder'),
              onChange: (value) => set({ whenToUse: value }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('skill.field.scope') },
            h(Segmented, {
              label: t('skill.field.scope'),
              value: draft.scope,
              onChange: setScope,
              options: [
                { value: 'global', label: t('skill.field.scope.global'), hint: t('skill.field.scope.globalHint') },
                { value: 'project', label: t('skill.field.scope.project'), hint: t('skill.field.scope.projectHint') },
              ],
            }),
          ),
          draft.scope === 'project'
            ? h(Field, { label: t('skill.field.workspaces'), hint: t('skill.field.workspacesHint') },
                h(WorkspacePicker, {
                  data,
                  rows: draft.workspaces,
                  onChange: (workspaces) => set({ workspaces }),
                }),
              )
            : null,
          h(Field, { label: t('skill.workspace.target') },
            h(
              'div',
              { className: 'asa-targets' },
              targets.map((target, index) =>
                h('code', { key: `${target}-${index}`, className: 'asa-target', title: target }, target),
              ),
            ),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-section' },
          h(Field, { label: t('skill.field.content'), hint: t('skill.field.contentHint') },
            h(TextArea, {
              value: draft.content,
              rows: 10,
              mono: true,
              placeholder: t('skill.field.contentPlaceholder'),
              onChange: (value) => set({ content: value }),
            }),
          ),
        ),

        h(
          'div',
          { className: 'asa-form-actions' },
          h(Button, { tone: 'primary', label: busy ? t('action.saving') : t('action.save'), onClick: onSave, disabled: busy }),
          h(Button, { label: t('action.cancel'), onClick: onCancel, disabled: busy }),
        ),
      )
    }

    /* ----------------------------------------------------------------- cards */

    function AgentCard(props) {
      const { agent, data, onEdit, onDelete, confirm, onConfirm, onCancelConfirm, busy } = props
      const skills = data.skills || []
      const chips = agent.skills.map((name) => ({
        key: name,
        label: skills.some((skill) => skill.name === name) ? name : `${name} ⚠`,
        tone: skills.some((skill) => skill.name === name) ? undefined : 'warn',
        title: skills.some((skill) => skill.name === name) ? undefined : t('panel.missingSkill'),
      }))
      const toolSummary =
        agent.tools === null || agent.tools === undefined
          ? t('panel.allTools')
          : formatCount(t('panel.toolCount'), agent.tools.length)
      const route =
        agent.model === undefined || agent.provider === undefined
          ? t('agent.model.inherit')
          : `${agent.provider}/${agent.model}${agent.reasoningEffort ? ` · ${agent.reasoningEffort}` : ''}`

      return h(
        'div',
        { className: 'asa-card' },
        h(
          'div',
          { className: 'asa-card-head' },
          h('span', { className: 'asa-card-title asa-mono' }, agent.name),
          agent.displayName && agent.displayName !== agent.name
            ? h('span', { className: 'asa-card-sub' }, agent.displayName)
            : null,
          h('span', { className: 'asa-card-spacer' }),
          confirm
            ? [
                h(Button, { key: 'c', tone: 'danger', label: t('action.confirm'), onClick: onConfirm, disabled: busy }),
                h(Button, { key: 'x', label: t('action.cancel'), onClick: onCancelConfirm, disabled: busy }),
              ]
            : [
                h(IconButton, { key: 'e', iconName: 'edit', label: t('action.edit'), onClick: onEdit }),
                h(IconButton, { key: 'd', iconName: 'trash', label: t('action.delete'), tone: 'danger', onClick: onDelete }),
              ],
        ),
        h(
          'div',
          { className: 'asa-card-badges' },
          h(Badge, { tone: agent.mode === 'fork' ? 'brand' : undefined, iconName: 'bot' },
            agent.mode === 'fork' ? 'fork' : 'spawn'),
          h(Badge, { title: route }, agent.model === undefined ? t('agent.model.inherit') : `${agent.provider}/${agent.model}`),
          agent.reasoningEffort ? h(Badge, null, agent.reasoningEffort) : null,
          h(Badge, null, toolSummary),
        ),
        agent.description ? h('div', { className: 'asa-card-desc' }, agent.description) : null,
        h(ChipList, { items: chips, empty: t('panel.noSkills') }),
      )
    }

    function SkillCard(props) {
      const { skill, data, onEdit, onDelete, confirm, onConfirm, onCancelConfirm, busy } = props
      const usedBy = (data.agents || []).filter((agent) => (agent.skills || []).includes(skill.name)).length
      const binding = skill.binding
      const scopeBadge =
        skill.scope === 'global' ? t('skill.scope.globalBadge') : t('skill.scope.projectBadge')
      let scopeDetail = ''
      if (skill.scope === 'global') {
        scopeDetail = t('skill.field.scope.globalHint')
      } else if (binding && binding.workspaces.length > 0) {
        const names = binding.workspaces.map((entry) => entry.title || entry.path)
        const sessionCount = binding.sessions.length
        scopeDetail = sessionCount > 0
          ? `${names.join('、')} · ${formatCount(t('panel.sessionCount'), sessionCount)}`
          : names.join('、')
      } else if (skill.workspaceName) {
        scopeDetail = skill.workspaceName
      }

      return h(
        'div',
        { className: 'asa-card' },
        h(
          'div',
          { className: 'asa-card-head' },
          h('span', { className: 'asa-card-title asa-mono' }, skill.name),
          h(Badge, { tone: skill.scope === 'global' ? undefined : 'brand' }, scopeBadge),
          h(Badge, null, skill.source === 'managed' ? t('skill.source.managed') : t('skill.source.filesystem')),
          h('span', { className: 'asa-card-spacer' }),
          confirm
            ? [
                h(Button, { key: 'c', tone: 'danger', label: t('action.confirm'), onClick: onConfirm, disabled: busy }),
                h(Button, { key: 'x', label: t('action.cancel'), onClick: onCancelConfirm, disabled: busy }),
              ]
            : [
                h(IconButton, { key: 'e', iconName: 'edit', label: t('action.edit'), onClick: onEdit }),
                h(IconButton, { key: 'd', iconName: 'trash', label: t('action.delete'), tone: 'danger', onClick: onDelete }),
              ],
        ),
        h('div', { className: 'asa-card-desc' }, skill.description),
        scopeDetail ? h('div', { className: 'asa-card-meta' }, scopeDetail) : null,
        h(
          'div',
          { className: 'asa-card-foot' },
          h('span', { className: 'asa-dim asa-path', title: skill.path },
            skill.path ? shortPath(skill.path, 46) : t('skill.workspace.managed')),
          h('span', { className: 'asa-card-spacer' }),
          usedBy > 0 ? h('span', { className: 'asa-dim' }, formatCount(t('panel.usedBy'), usedBy)) : null,
        ),
      )
    }

    /* ---------------------------------------------------------------- column */

    function Column(props) {
      const { title, hint, count, onNew, children, editorTitle, editing, onCloseEditor } = props
      return h(
        'section',
        { className: 'asa-col' },
        h(
          'div',
          { className: 'asa-col-head' },
          editing
            ? h(
                'div',
                { className: 'asa-col-head-main' },
                h(IconButton, { iconName: 'close', label: t('action.cancel'), onClick: onCloseEditor }),
                h('span', { className: 'asa-col-title' }, editorTitle),
              )
            : h(
                'div',
                { className: 'asa-col-head-main' },
                h('span', { className: 'asa-col-title' }, title),
                h('span', { className: 'asa-col-count' }, formatCount(t('panel.count'), count)),
                h('span', { className: 'asa-col-hint' }, hint),
              ),
          editing
            ? null
            : h(Button, { tone: 'primary', iconName: 'plus', label: t('action.new'), onClick: onNew }),
        ),
        children,
      )
    }

    /* ------------------------------------------------------------------ page */

    /**
     * One thrown render blanks a slot entry; keep a readable failure surface and
     * a retry instead of leaving the main column empty.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.retry = this.retry.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[dsh-agent-skill] panel crashed', error, info)
        } catch {
          /* ignore */
        }
      }

      retry() {
        this.setState({ error: null })
      }

      render() {
        if (this.state.error) {
          const message =
            this.state.error && this.state.error.message
              ? String(this.state.error.message)
              : String(this.state.error)
          return h(
            'div',
            { className: 'asa-page' },
            h(
              'div',
              { className: 'asa-placeholder' },
              h('div', { className: 'asa-placeholder-title' }, t('panel.error')),
              h('div', { className: 'asa-placeholder-hint asa-mono' }, message),
              h(Button, { tone: 'primary', label: t('panel.retry'), onClick: this.retry }),
            ),
          )
        }
        return this.props.children
      }
    }

    function PageEntry() {
      return h(Boundary, null, h(Page))
    }

    function Page() {
      const host = useHostState()
      const data = host.data
      const [agentEditor, setAgentEditor] = useState(null)
      const [skillEditor, setSkillEditor] = useState(null)
      const [busy, setBusy] = useState(false)
      const [agentError, setAgentError] = useState(null)
      const [skillError, setSkillError] = useState(null)
      const [toast, setToast] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const toastTimer = useRef(0)

      const showToast = useCallback((text) => {
        try {
          window.clearTimeout(toastTimer.current)
        } catch {
          /* ignore */
        }
        setToast(text)
        toastTimer.current = window.setTimeout(() => setToast(null), 2600)
      }, [])

      useEffect(
        () => () => {
          try {
            window.clearTimeout(toastTimer.current)
          } catch {
            /* ignore */
          }
        },
        [],
      )

      const refresh = useCallback(async () => {
        await host.reload()
      }, [host])

      const copyCallTemplate = useCallback(async () => {
        const template = 'delegate_agent(agent: "<名称>", prompt: "<完整任务>")'
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(template)
            showToast(t('panel.copied'))
          }
        } catch {
          showToast(t('error.request-failed'))
        }
      }, [showToast])

      const saveAgent = useCallback(async () => {
        if (!agentEditor) return
        setBusy(true)
        setAgentError(null)
        try {
          await postJson(API_AGENT_SAVE, agentEditor.draft)
          setAgentEditor(null)
          showToast(t('toast.savedAgent'))
          await host.reload()
        } catch (error) {
          setAgentError(describeError(error))
        } finally {
          setBusy(false)
        }
      }, [agentEditor, host, showToast])

      const saveSkill = useCallback(async () => {
        if (!skillEditor) return
        const draft = skillEditor.draft
        const payload = {
          originalName: draft.originalName,
          name: draft.name,
          description: draft.description,
          whenToUse: draft.whenToUse,
          content: draft.content,
          scope: draft.scope,
          workspaces:
            draft.scope === 'project'
              ? draft.workspaces
                  .filter((row) => row.included)
                  .map((row) => ({
                    path: row.path,
                    mode: row.mode,
                    sessions: row.mode === 'sessions' ? row.sessions : [],
                  }))
              : [],
        }
        if (draft.scope === 'project') {
          if (payload.workspaces.length === 0) {
            setSkillError(t('error.workspace-required'))
            return
          }
          const missing = payload.workspaces.some(
            (row) => row.mode === 'sessions' && row.sessions.length === 0,
          )
          if (missing) {
            setSkillError(t('error.session-required'))
            return
          }
        }
        setBusy(true)
        setSkillError(null)
        try {
          await postJson(API_SKILL_SAVE, payload)
          setSkillEditor(null)
          showToast(t('toast.savedSkill'))
          await host.reload()
        } catch (error) {
          setSkillError(describeError(error))
        } finally {
          setBusy(false)
        }
      }, [host, showToast, skillEditor])

      const deleteAgent = useCallback(async (agent) => {
        setBusy(true)
        try {
          await postJson(API_AGENT_DELETE, { id: agent.id })
          setConfirm(null)
          showToast(t('toast.deletedAgent'))
          await host.reload()
        } catch (error) {
          showToast(describeError(error))
        } finally {
          setBusy(false)
        }
      }, [host, showToast])

      const deleteSkill = useCallback(async (skill) => {
        setBusy(true)
        try {
          await postJson(API_SKILL_DELETE, { name: skill.name, path: skill.path })
          setConfirm(null)
          showToast(t('toast.deletedSkill'))
          await host.reload()
        } catch (error) {
          showToast(describeError(error))
        } finally {
          setBusy(false)
        }
      }, [host, showToast])

      const header = h(
        'header',
        { className: 'asa-header' },
        h(
          'div',
          { className: 'asa-header-main' },
          h('div', { className: 'asa-title' }, t('panel.title')),
          h('div', { className: 'asa-subtitle' }, t('panel.subtitle')),
        ),
        h(
          'div',
          { className: 'asa-header-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'asa-callhint',
              title: t('panel.copyHint'),
              onClick: copyCallTemplate,
            },
            h('span', { className: 'asa-callhint-label' }, t('panel.callhint')),
            h(
              'code',
              { className: 'asa-mono' },
              'delegate_agent(agent: "<名称>", prompt: "…")',
            ),
            icon('copy', 12),
          ),
          h(Button, {
            iconName: 'refresh',
            label: t('panel.refresh'),
            onClick: refresh,
            disabled: host.status === 'loading' || host.status === 'refreshing',
          }),
        ),
      )

      if (data === null) {
        return h(
          'div',
          { className: 'asa-page' },
          header,
          h(
            'div',
            { className: 'asa-placeholder' },
            host.status === 'error'
              ? [
                  h('div', { key: 't', className: 'asa-placeholder-title' }, t('panel.error')),
                  h('div', { key: 'h', className: 'asa-placeholder-hint' }, describeError(host.error)),
                  h(Button, { key: 'b', tone: 'primary', label: t('panel.retry'), onClick: refresh }),
                ]
              : [
                  h(Spinner, { key: 's' }),
                  h('div', { key: 't', className: 'asa-placeholder-title' }, t('panel.loading')),
                  h('div', { key: 'h', className: 'asa-placeholder-hint' }, t('panel.loadingHint')),
                ],
          ),
        )
      }

      const agents = data.agents || []
      const skills = data.skills || []

      return h(
        'div',
        { className: 'asa-page' },
        header,
        host.status === 'error'
          ? h(
              'div',
              { className: 'asa-banner', role: 'alert' },
              describeError(host.error),
              h(Button, { tone: 'ghost', label: t('panel.retry'), onClick: refresh }),
            )
          : null,
        h(
          'div',
          { className: 'asa-body' },
          h(
            Column,
            {
              title: t('panel.agents'),
              hint: t('panel.agents.hint'),
              count: agents.length,
              onNew: () => {
                setAgentError(null)
                setSkillEditor(null)
                setAgentEditor({ draft: emptyAgentDraft(), isNew: true })
              },
              editing: agentEditor !== null,
              editorTitle: agentEditor && !agentEditor.isNew ? t('agent.edit') : t('agent.new'),
              onCloseEditor: () => setAgentEditor(null),
            },
            agentEditor
              ? h(AgentEditor, {
                  data,
                  draft: agentEditor.draft,
                  onChange: (draft) => setAgentEditor({ ...agentEditor, draft }),
                  onSave: saveAgent,
                  onCancel: () => setAgentEditor(null),
                  busy,
                  error: agentError,
                })
              : h(
                  'div',
                  { className: 'asa-list' },
                  agents.length === 0
                    ? h(
                        'div',
                        { className: 'asa-empty' },
                        h('div', { className: 'asa-empty-title' }, t('panel.empty.agents')),
                        h('div', { className: 'asa-empty-hint' }, t('panel.empty.agentsHint')),
                        h(Button, {
                          tone: 'primary',
                          iconName: 'plus',
                          label: t('action.new'),
                          onClick: () => setAgentEditor({ draft: emptyAgentDraft(), isNew: true }),
                        }),
                      )
                    : agents.map((agent) =>
                        h(AgentCard, {
                          key: agent.id,
                          agent,
                          data,
                          busy,
                          confirm: confirm?.kind === 'agent' && confirm.id === agent.id,
                          onEdit: () => {
                            setAgentError(null)
                            setAgentEditor({ draft: agentDraftOf(agent), isNew: false })
                          },
                          onDelete: () => setConfirm({ kind: 'agent', id: agent.id }),
                          onConfirm: () => deleteAgent(agent),
                          onCancelConfirm: () => setConfirm(null),
                        }),
                      ),
                ),
          ),
          h(
            Column,
            {
              title: t('panel.skills'),
              hint: t('panel.skills.hint'),
              count: skills.length,
              onNew: () => {
                setSkillError(null)
                setAgentEditor(null)
                setSkillEditor({ draft: skillDraftOf(undefined, data.workspaces || []), isNew: true })
              },
              editing: skillEditor !== null,
              editorTitle: skillEditor && !skillEditor.isNew ? t('skill.edit') : t('skill.new'),
              onCloseEditor: () => setSkillEditor(null),
            },
            skillEditor
              ? h(SkillEditor, {
                  data,
                  draft: skillEditor.draft,
                  onChange: (draft) => setSkillEditor({ ...skillEditor, draft }),
                  onSave: saveSkill,
                  onCancel: () => setSkillEditor(null),
                  busy,
                  error: skillError,
                })
              : h(
                  'div',
                  { className: 'asa-list' },
                  skills.length === 0
                    ? h(
                        'div',
                        { className: 'asa-empty' },
                        h('div', { className: 'asa-empty-title' }, t('panel.empty.skills')),
                        h('div', { className: 'asa-empty-hint' }, t('panel.empty.skillsHint')),
                        h(Button, {
                          tone: 'primary',
                          iconName: 'plus',
                          label: t('action.new'),
                          onClick: () =>
                            setSkillEditor({ draft: skillDraftOf(undefined, data.workspaces || []), isNew: true }),
                        }),
                      )
                    : skills.map((skill) =>
                        h(SkillCard, {
                          key: skill.path || skill.name,
                          skill,
                          data,
                          busy,
                          confirm: confirm?.kind === 'skill' && confirm.name === skill.name,
                          onEdit: () => {
                            setSkillError(null)
                            setSkillEditor({ draft: skillDraftOf(skill, data.workspaces || []), isNew: false })
                          },
                          onDelete: () => setConfirm({ kind: 'skill', name: skill.name }),
                          onConfirm: () => deleteSkill(skill),
                          onCancelConfirm: () => setConfirm(null),
                        }),
                      ),
                ),
          ),
        ),
        data.paths
          ? h(
              'footer',
              { className: 'asa-footer' },
              h('span', null, `${t('panel.host')} · ${shortPath(data.paths.store, 52)}`),
              h('span', { className: 'asa-footer-dot' }, '·'),
              h('span', null, `${t('panel.globalRoot')} · ${shortPath(data.paths.globalSkills, 52)}`),
            )
          : null,
        toast ? h('div', { className: 'asa-toast', role: 'status' }, toast) : null,
      )
    }

    /* ----------------------------------------------------------------- style */

    const CSS = `
.asa-page { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;
  background:var(--dsw-alias-bg-base,#fff); color:var(--dsw-alias-label-primary,#1b1b1f); font-family:inherit; font-size:13px; }
.asa-header { flex:none; display:flex; align-items:flex-start; gap:12px; padding:14px 18px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-layer-1,#f6f6f8); }
.asa-header-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:3px; }
.asa-title { font-size:15px; font-weight:600; letter-spacing:.01em; }
.asa-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-header-actions { display:flex; align-items:center; gap:8px; flex:none; }
.asa-callhint { display:inline-flex; align-items:center; gap:7px; height:30px; padding:0 10px; max-width:420px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4ea); border-radius:8px; background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-secondary,#6b6b76); font:inherit; font-size:11px; cursor:pointer; overflow:hidden; }
.asa-callhint:hover { border-color:var(--dsw-alias-border-l2,#c9c9d2); }
.asa-callhint code { color:var(--dsw-alias-label-primary,#1b1b1f); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.asa-callhint-label { flex:none; }
.asa-banner { flex:none; display:flex; align-items:center; gap:10px; padding:8px 18px;
  background:var(--dsw-alias-bg-layer-2,#ececf1); color:var(--dsw-alias-state-error-primary,#c0392b); font-size:12px; }
.asa-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:14px;
  padding:14px 18px; overflow:hidden; }
.asa-col { display:flex; flex-direction:column; min-height:0; overflow:hidden; border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-layer-1,#f6f6f8); }
.asa-col-head { flex:none; display:flex; align-items:center; gap:8px; padding:9px 11px;
  border-bottom:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-layer-1,#f6f6f8); }
.asa-col-head-main { flex:1; min-width:0; display:flex; align-items:center; gap:8px; }
.asa-col-title { font-size:13px; font-weight:600; white-space:nowrap; }
.asa-col-count { font-size:11px; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-col-hint { font-size:11px; color:var(--dsw-alias-label-secondary,#6b6b76); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asa-list { flex:1; min-height:0; overflow:auto; padding:10px; display:flex; flex-direction:column; gap:9px; }
.asa-form { flex:1; min-height:0; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:14px; }
.asa-form-section { display:flex; flex-direction:column; gap:10px; padding-bottom:12px;
  border-bottom:1px solid var(--dsw-alias-border-l1,#e4e4ea); }
.asa-form-section:last-of-type { border-bottom:none; padding-bottom:2px; }
.asa-form-error { padding:8px 10px; border-radius:8px; font-size:12px; line-height:1.5;
  color:var(--dsw-alias-state-error-primary,#c0392b); border:1px solid var(--dsw-alias-state-error-primary,#c0392b);
  background:var(--dsw-alias-bg-base,#fff); }
.asa-form-actions { display:flex; gap:8px; padding-top:2px; }
.asa-field { display:flex; flex-direction:column; gap:5px; }
.asa-field-head { display:flex; align-items:baseline; gap:8px; min-width:0; }
.asa-field-label { font-size:12px; font-weight:600; flex:none; }
.asa-field-hint { font-size:11px; color:var(--dsw-alias-label-secondary,#6b6b76); overflow:hidden; text-overflow:ellipsis; }
.asa-req { color:var(--dsw-alias-state-error-primary,#c0392b); }
.asa-input { width:100%; box-sizing:border-box; padding:6px 9px; border-radius:8px; font:inherit; font-size:12.5px;
  color:var(--dsw-alias-label-primary,#1b1b1f); background:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-border-l1,#e4e4ea); }
.asa-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary,#3b6ef5); }
.asa-input:disabled { opacity:.55; cursor:not-allowed; }
.asa-input-num { width:88px; }
.asa-textarea { resize:vertical; min-height:52px; line-height:1.55; }
.asa-select { appearance:auto; cursor:pointer; }
.asa-mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
.asa-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:28px; padding:0 10px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#1b1b1f); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; flex:none; }
.asa-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2,#c9c9d2); }
.asa-btn:disabled { opacity:.55; cursor:not-allowed; }
.asa-btn-wide { flex:1; }
.asa-btn[data-tone="primary"] { background:var(--dsw-alias-brand-primary,#3b6ef5);
  border-color:var(--dsw-alias-brand-primary,#3b6ef5); color:#fff; }
.asa-btn[data-tone="primary"]:hover:not(:disabled) { filter:brightness(1.06); }
.asa-btn[data-tone="danger"] { color:var(--dsw-alias-state-error-primary,#c0392b);
  border-color:var(--dsw-alias-state-error-primary,#c0392b); background:transparent; }
.asa-btn[data-tone="ghost"] { background:transparent; border-color:transparent; color:var(--dsw-alias-label-secondary,#6b6b76); height:24px; padding:0 6px; }
.asa-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0;
  border-radius:7px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary,#6b6b76);
  cursor:pointer; flex:none; }
.asa-icon-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2,#ececf1); color:var(--dsw-alias-label-primary,#1b1b1f); }
.asa-icon-btn[data-tone="danger"]:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary,#c0392b); }
.asa-icon-btn:disabled { opacity:.5; cursor:not-allowed; }
.asa-badge { display:inline-flex; align-items:center; gap:4px; height:18px; padding:0 7px; border-radius:999px;
  font-size:10.5px; color:var(--dsw-alias-label-secondary,#6b6b76); background:var(--dsw-alias-bg-layer-2,#ececf1);
  border:1px solid var(--dsw-alias-border-l1,#e4e4ea); white-space:nowrap; }
.asa-badge[data-tone="brand"] { color:var(--dsw-alias-brand-primary,#3b6ef5); border-color:currentColor; background:transparent; }
.asa-card { display:flex; flex-direction:column; gap:6px; padding:10px 11px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-base,#fff); }
.asa-card:hover { border-color:var(--dsw-alias-border-l2,#c9c9d2); }
.asa-card-head { display:flex; align-items:center; gap:6px; min-width:0; }
.asa-card-title { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asa-card-sub { font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b6b76); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asa-card-spacer { flex:1; min-width:4px; }
.asa-card-badges { display:flex; flex-wrap:wrap; gap:5px; }
.asa-card-desc { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary,#6b6b76);
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.asa-card-meta { font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-card-foot { display:flex; align-items:center; gap:8px; min-width:0; }
.asa-path { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:60%; }
.asa-chips { display:flex; flex-wrap:wrap; gap:4px; }
.asa-chip { display:inline-flex; align-items:center; height:18px; padding:0 6px; border-radius:6px; font-size:10.5px;
  background:var(--dsw-alias-bg-layer-2,#ececf1); color:var(--dsw-alias-label-secondary,#6b6b76);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.asa-chip[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary,#a4760c); }
.asa-dim { font-size:11.5px; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-warn { font-size:11.5px; color:var(--dsw-alias-state-warn-primary,#a4760c); }
.asa-check { display:flex; align-items:flex-start; gap:7px; padding:4px 6px; border-radius:7px; cursor:pointer; min-width:0; }
.asa-check:hover { background:var(--dsw-alias-bg-layer-2,#ececf1); }
.asa-check input { margin:1px 0 0; flex:none; accent-color:var(--dsw-alias-brand-primary,#3b6ef5); }
.asa-check-body { display:flex; flex-direction:column; gap:1px; min-width:0; }
.asa-check-label { font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asa-check-detail { font-size:10.5px; color:var(--dsw-alias-label-secondary,#6b6b76); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.asa-seg { display:flex; gap:6px; }
.asa-seg-btn { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; text-align:left; padding:7px 9px;
  border-radius:8px; border:1px solid var(--dsw-alias-border-l1,#e4e4ea); background:var(--dsw-alias-bg-base,#fff);
  color:inherit; font:inherit; cursor:pointer; }
.asa-seg-btn:hover { border-color:var(--dsw-alias-border-l2,#c9c9d2); }
.asa-seg-btn[data-active="true"] { border-color:var(--dsw-alias-brand-primary,#3b6ef5); background:var(--dsw-alias-bg-layer-2,#ececf1); }
.asa-seg-title { font-size:12px; font-weight:600; }
.asa-seg-hint { font-size:10.5px; line-height:1.4; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-multi { border:1px solid var(--dsw-alias-border-l1,#e4e4ea); border-radius:8px; background:var(--dsw-alias-bg-base,#fff); overflow:hidden; }
.asa-multi-head { display:flex; align-items:center; gap:6px; padding:5px 6px; border-bottom:1px solid var(--dsw-alias-border-l1,#e4e4ea); }
.asa-multi-head .asa-input { flex:1; }
.asa-multi-list { max-height:140px; overflow:auto; padding:3px; }
.asa-multi-tall { max-height:190px; }
.asa-multi-sessions { margin-top:6px; }
.asa-ws { display:flex; flex-direction:column; gap:6px; }
.asa-ws-row { border:1px solid var(--dsw-alias-border-l1,#e4e4ea); border-radius:9px; background:var(--dsw-alias-bg-base,#fff); overflow:hidden; }
.asa-ws-row[data-included="true"] { border-color:var(--dsw-alias-border-l2,#c9c9d2); }
.asa-ws-head { display:flex; align-items:flex-start; gap:6px; padding:6px 8px; }
.asa-ws-head .asa-check { flex:1; }
.asa-ws-tools { display:flex; align-items:center; gap:4px; flex:none; padding-top:2px; }
.asa-ws-count { white-space:nowrap; }
.asa-ws-body { padding:2px 8px 9px; display:flex; flex-direction:column; gap:6px; }
.asa-targets { display:flex; flex-direction:column; gap:4px; }
.asa-target { display:block; padding:4px 7px; border-radius:6px; font-size:10.5px;
  background:var(--dsw-alias-bg-layer-2,#ececf1); color:var(--dsw-alias-label-secondary,#6b6b76);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asa-disclosure { display:inline-flex; align-items:center; gap:6px; padding:0; border:none; background:transparent;
  color:var(--dsw-alias-label-secondary,#6b6b76); font:inherit; font-size:12px; cursor:pointer; align-self:flex-start; }
.asa-disclosure-mark { display:inline-flex; transition:transform .15s ease; }
.asa-disclosure-mark.asa-open { transform:rotate(90deg); }
.asa-empty { display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding:16px 12px; border-radius:10px;
  border:1px dashed var(--dsw-alias-border-l2,#c9c9d2); background:var(--dsw-alias-bg-base,#fff); }
.asa-empty-title { font-size:13px; font-weight:600; }
.asa-empty-hint { font-size:12px; line-height:1.55; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-placeholder { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px;
  padding:40px 24px; text-align:center; }
.asa-placeholder-title { font-size:14px; font-weight:600; }
.asa-placeholder-hint { font-size:12px; max-width:520px; line-height:1.6; color:var(--dsw-alias-label-secondary,#6b6b76); }
.asa-footer { flex:none; display:flex; align-items:center; gap:8px; padding:7px 18px;
  font-size:10.5px; color:var(--dsw-alias-label-secondary,#6b6b76); border-top:1px solid var(--dsw-alias-border-l1,#e4e4ea);
  overflow:hidden; white-space:nowrap; }
.asa-footer-dot { opacity:.5; }
.asa-toast { position:absolute; left:50%; bottom:20px; transform:translateX(-50%); padding:8px 14px; border-radius:999px;
  font-size:12px; background:var(--dsw-alias-bg-overlay,#1b1b1f); color:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-border-l2,#c9c9d2); box-shadow:0 6px 18px rgba(0,0,0,.18); z-index:5; }
.asa-spinner { width:18px; height:18px; border-radius:50%; border:2px solid var(--dsw-alias-border-l2,#c9c9d2);
  border-top-color:var(--dsw-alias-brand-primary,#3b6ef5); animation:asa-spin .8s linear infinite; }
@keyframes asa-spin { to { transform:rotate(360deg); } }
@media (max-width: 860px) {
  .asa-body { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(0,1fr); overflow:auto; }
  .asa-col { min-height:320px; }
  .asa-callhint { display:none; }
}
`

    /* ------------------------------------------------------------------ apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        const disposers = []
        const locale = (() => {
          try {
            return ctx.get('locale', false)
          } catch {
            return undefined
          }
        })()
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => {
            try {
              return locale.register(NS, { zh: ZH, en: EN })
            } catch {
              return () => {}
            }
          })
          try {
            const bound = locale.bind ? locale.bind(NS) : undefined
            if (typeof bound === 'function') translate = makeTranslator({ translate: bound })
            else translate = makeTranslator(undefined)
          } catch {
            translate = makeTranslator(undefined)
          }
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })

        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 6,
                label: () => t('panel.title'),
              },
              PanelIcon,
            ),
          ),
        )
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
              },
              PageEntry,
            ),
          ),
        )

        ctx.effect(() => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          }
        })
      },
    }
  },
})
