/**
 * Host half of dsh-agent-skill: "Agent & Skill".
 *
 * Two stores live behind one plugin:
 *
 *   - Subagent definitions (`<dshHome>/agent-skill/agents.json`). Each one names
 *     a callable subagent together with its model route, reasoning effort,
 *     spawn/fork backend, tool allowlist and skill bundle.
 *   - Skill files (`SKILL.md` bundles) on the roots the shipped filesystem
 *     provider already scans — `<dshHome>/skills` for global skills and
 *     `<workspace>/.dsh/skills` for project skills — plus a managed copy for
 *     skills the user scoped to individual conversations instead of a whole
 *     workspace. `<dshHome>/agent-skill/skills.json` records those bindings.
 *
 * The model-facing side is one `delegate_agent` tool. It starts a managed
 * activation through `ctx.subagents` on the backend the definition picked,
 * prepends the selected skills' instruction bodies to the child prompt, and
 * forwards the configured LLM route as `agentOptions`. The definition's tool
 * allowlist is applied to the child session both as a scope restriction (the
 * model stops seeing the tools) and as an execution guard.
 *
 * Skills bound to individual conversations cannot be scoped by the skill
 * registry, which resolves by working directory only, so the Host registers a
 * per-agent `systemPrompt` section on that agent's own context: exactly the
 * sessions listed in a binding receive those instructions.
 *
 * Endpoints (all loopback / paired-device fenced):
 *   GET  /api/dsh-agent-skill/state
 *   GET  /api/dsh-agent-skill/model?provider=<id>&model=<id>
 *   GET  /api/dsh-agent-skill/skill?path=<absolute SKILL.md>
 *   POST /api/dsh-agent-skill/agents/save
 *   POST /api/dsh-agent-skill/agents/delete
 *   POST /api/dsh-agent-skill/skills/save
 *   POST /api/dsh-agent-skill/skills/delete
 */

import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const PLUGIN_ID = 'dsh-agent-skill'
const ROUTE_BASE = '/api/dsh-agent-skill'

const STATE_ROUTE = `${ROUTE_BASE}/state`
const MODEL_ROUTE = `${ROUTE_BASE}/model`
const SKILL_ROUTE = `${ROUTE_BASE}/skill`
const AGENT_SAVE_ROUTE = `${ROUTE_BASE}/agents/save`
const AGENT_DELETE_ROUTE = `${ROUTE_BASE}/agents/delete`
const AGENT_REORDER_ROUTE = `${ROUTE_BASE}/agents/reorder`
const SKILL_SAVE_ROUTE = `${ROUTE_BASE}/skills/save`
const SKILL_DELETE_ROUTE = `${ROUTE_BASE}/skills/delete`
const SKILL_REORDER_ROUTE = `${ROUTE_BASE}/skills/reorder`

const TOOL_NAME = 'delegate_agent'
const SECTION_NAME = `${PLUGIN_ID}/session-skills`

const MAX_BODY_BYTES = 512 * 1024
const MAX_SKILL_BYTES = 48 * 1024
const MAX_SKILL_DESCRIPTION_BYTES = 4_000
const MAX_INJECTED_SKILL_CHARS = 24_000
const MAX_AGENT_NAME = 48
const MAX_LISTED_SESSIONS = 400
const MAX_TITLED_SESSIONS = 200

/* ------------------------------------------------------------------ paths */

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

function resolveAgentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.agents')
}

function storeDir() {
  return path.join(resolveDshHome(), 'agent-skill')
}

function agentsFile() {
  return path.join(storeDir(), 'agents.json')
}

function bindingsFile() {
  return path.join(storeDir(), 'skills.json')
}

function managedRoot() {
  return path.join(storeDir(), 'managed-skills')
}

function managedSkillDir(name) {
  return path.join(managedRoot(), name)
}

function childrenFile() {
  return path.join(storeDir(), 'children.json')
}

function canonicalKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInsideAny(target, roots) {
  const key = canonicalKey(target)
  return roots.some((root) => key === root || key.startsWith(root + path.sep))
}

/* ------------------------------------------------------------------ trust */

function useService(ctx, name) {
  try {
    if (typeof ctx?.get !== 'function') return undefined
    return ctx.get(name, false) ?? undefined
  } catch {
    return undefined
  }
}

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  return isIPv4Loopback(hostname)
}

function isProxiedRequest(request) {
  const headers = request.headers
  return (
    headers['cf-connecting-ip'] !== undefined ||
    headers['x-forwarded-for'] !== undefined ||
    headers['x-real-ip'] !== undefined ||
    headers['x-forwarded-host'] !== undefined ||
    headers['x-forwarded-proto'] !== undefined ||
    headers.forwarded !== undefined
  )
}

function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function lookupPairing(ctx) {
  const direct = useService(ctx, 'remoteWebUiPairing')
  if (direct !== undefined) return direct
  try {
    return ctx?.remoteWebUiPairing ?? undefined
  } catch {
    return undefined
  }
}

function isAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true
  // Connection owns the browser-authentication fence for every /api route; ask
  // it before the local pairing fallback so a paired/remote page keeps working.
  const connection = useService(ctx, 'connection')
  if (connection && typeof connection.requestRejection === 'function') {
    try {
      const rejection = connection.requestRejection({
        headers: request.headers,
      })
      if (rejection === undefined) return true
      return false
    } catch {
      /* fall through to the pairing check */
    }
  }
  try {
    return lookupPairing(ctx)?.isPairedDevice?.(request) === true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------- http utils */

function requestUrl(request) {
  const raw = request.url
  if (typeof raw !== 'string') return undefined
  try {
    return new URL(raw, 'http://localhost')
  } catch {
    return undefined
  }
}

function sendJson(request, response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const text = await readBody(request)
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('invalid-json')
  }
}

function methodAllowed(request, response, methods) {
  const method = (request.method || 'GET').toUpperCase()
  if (methods.includes(method)) return true
  response.writeHead(405, { allow: methods.join(', ') })
  response.end()
  return false
}

function httpError(status, code) {
  const error = new Error(code)
  error.status = status
  return error
}

/* ------------------------------------------------------------ frontmatter */

/**
 * Parse the YAML subset a SKILL.md frontmatter uses: flat `key: value` pairs,
 * quoted strings, and `|` / `>` block scalars. Unknown keys are kept as
 * strings; nothing else is interpreted.
 */
function parseFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: normalized }
  const head = normalized.slice(4, end)
  let body = normalized.slice(end + 4)
  if (body.startsWith('\n')) body = body.slice(1)

  const data = {}
  const lines = head.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]
    let value = match[2]
    if (/^[|>][+-]?$/.test(value.trim())) {
      const collected = []
      let cursor = index + 1
      while (cursor < lines.length && (lines[cursor].startsWith('  ') || lines[cursor].trim() === '')) {
        collected.push(lines[cursor].replace(/^ {2}/, ''))
        cursor += 1
      }
      index = cursor - 1
      const joiner = value.trim().startsWith('>') ? ' ' : '\n'
      data[key] = collected.join(joiner).replace(/\s+$/, '')
      continue
    }
    const trimmed = value.trim()
    if (trimmed.length >= 2) {
      const first = trimmed[0]
      const last = trimmed[trimmed.length - 1]
      if (first === '"' && last === '"') {
        try {
          data[key] = JSON.parse(trimmed)
        } catch {
          data[key] = trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        }
        continue
      }
      if (first === "'" && last === "'") {
        data[key] = trimmed.slice(1, -1).replace(/''/g, "'")
        continue
      }
    }
    data[key] = trimmed
  }
  return { data, body }
}

function yamlScalar(value) {
  // A JSON string is a valid YAML double-quoted scalar, and it is the only form
  // that survives `: `, ` #`, leading indicators, boolean/number lookalikes and
  // embedded newlines. The shipped filesystem provider parses frontmatter with
  // the real `yaml` package and drops a skill whose fields are not strings.
  return JSON.stringify(String(value ?? ''))
}

function renderSkillFile({ name, description, whenToUse, content }) {
  const lines = ['---', `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`]
  if (typeof whenToUse === 'string' && whenToUse.trim() !== '') {
    lines.push(`whenToUse: ${yamlScalar(whenToUse.trim())}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${String(content ?? '').replace(/\s+$/, '')}\n`
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

function normalizeSkillName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
}

async function readSkillFile(filePath) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return undefined
    const text = await fs.readFile(filePath, 'utf8')
    if (text.length > MAX_SKILL_BYTES) return undefined
    const { data, body } = parseFrontmatter(text)
    const name =
      typeof data.name === 'string' && data.name !== ''
        ? data.name
        : path.basename(path.dirname(filePath))
    if (typeof data.description !== 'string' || data.description.trim() === '') return undefined
    return {
      name,
      description: data.description,
      whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : undefined,
      content: body.replace(/\s+$/, ''),
      path: filePath,
    }
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------ workspaces */

/**
 * The skill filesystem provider resolves a project root to the nearest `.git`
 * ancestor of the session cwd (falling back to the cwd). Use the same rule so a
 * skill written for a workspace is the skill the model actually discovers.
 */
function projectRootOf(workspacePath) {
  let current = path.resolve(workspacePath)
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(workspacePath)
    current = parent
  }
}

function listWorkspaces(ctx) {
  const out = []
  const seen = new Set()
  const registry = useService(ctx, 'workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    let rows = []
    try {
      rows = registry.list() || []
    } catch {
      rows = []
    }
    for (const workspace of rows) {
      const workspacePath = workspace?.path ?? workspace?.directory
      if (typeof workspacePath !== 'string' || workspacePath === '') continue
      const key = canonicalKey(workspacePath)
      if (seen.has(key)) continue
      seen.add(key)
      const title =
        typeof workspace?.title === 'string' && workspace.title.trim() !== ''
          ? workspace.title.trim()
          : path.basename(workspacePath) || workspacePath
      const projectRoot = projectRootOf(workspacePath)
      out.push({
        path: workspacePath,
        title,
        projectRoot,
        // True when the workspace itself is the project root the provider scans.
        projectRootIsWorkspace: canonicalKey(projectRoot) === key,
      })
    }
  }
  return out
}

function workspaceSkillRoots(workspaces) {
  const rows = []
  const seen = new Set()
  for (const workspace of workspaces) {
    const root = workspace.projectRoot ?? workspace.path
    for (const candidate of [
      path.join(root, '.dsh', 'skills'),
      path.join(root, '.agents', 'skills'),
    ]) {
      const key = canonicalKey(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ root: candidate, scope: 'project', workspace, projectRoot: root })
    }
  }
  return rows
}

function globalSkillRoots() {
  return [
    { root: path.join(resolveDshHome(), 'skills'), label: 'global' },
    { root: path.join(resolveAgentsHome(), 'skills'), label: 'global-agents' },
  ]
}

function allSkillRoots(ctx) {
  const workspaces = listWorkspaces(ctx)
  return { roots: globalSkillRoots(), projectRoots: workspaceSkillRoots(workspaces), workspaces }
}

async function scanSkillRoot(root, meta) {
  const found = []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    let filePath
    if (entry.isDirectory()) filePath = path.join(root, entry.name, 'SKILL.md')
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) filePath = path.join(root, entry.name)
    else continue
    const skill = await readSkillFile(filePath)
    if (!skill) continue
    found.push({
      ...skill,
      scope: meta.scope,
      source: 'filesystem',
      workspacePath: meta.workspace?.path,
      workspaceName: meta.workspace?.title,
      projectRoot: meta.projectRoot,
      root,
      writable: true,
    })
  }
  return found
}

/* ------------------------------------------------------------- agent store */

function normalizeAgentName(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') throw new Error('agent-name-required')
  if (text.length > MAX_AGENT_NAME) throw new Error('agent-name-too-long')
  if (/[/\\]/.test(text)) throw new Error('agent-name-invalid')
  return text
}

function normalizeToolList(value) {
  if (!Array.isArray(value)) return null
  const tools = [...new Set(value.map((item) => String(item ?? '').trim()).filter((item) => item !== ''))]
  return tools.length > 0 ? tools.sort() : null
}

function normalizeAgent(raw, existing) {
  const now = Date.now()
  const name = normalizeAgentName(raw?.name ?? existing?.name ?? '')
  const mode = raw?.mode === 'fork' ? 'fork' : 'spawn'
  const provider = String(raw?.provider ?? existing?.provider ?? '').trim()
  const model = String(raw?.model ?? existing?.model ?? '').trim()
  const reasoningEffort = String(raw?.reasoningEffort ?? existing?.reasoningEffort ?? '').trim()
  const maxDepthRaw = Number(raw?.maxDepth ?? existing?.maxDepth ?? 1)
  const maxDepth = Number.isFinite(maxDepthRaw) ? Math.max(0, Math.trunc(maxDepthRaw)) : 1
  if (model !== '' && provider === '') throw new Error('model-provider-required')
  // `null` is an explicit "all tools"; only an omitted field inherits.
  const toolsSource = raw !== null && raw !== undefined && raw.tools !== undefined ? raw.tools : existing?.tools

  return {
    id: existing?.id || `agent_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    displayName: String(raw?.displayName ?? existing?.displayName ?? '').trim() || name,
    description: String(raw?.description ?? existing?.description ?? '').trim(),
    systemPrompt: String(raw?.systemPrompt ?? existing?.systemPrompt ?? '').trim(),
    mode,
    provider: provider === '' ? undefined : provider,
    model: model === '' ? undefined : model,
    reasoningEffort: reasoningEffort === '' ? undefined : reasoningEffort,
    maxDepth,
    order: Number.isFinite(raw?.order) ? raw.order : existing?.order,
    tools: normalizeToolList(toolsSource),
    skills: Array.isArray(raw?.skills ?? existing?.skills)
      ? [
          ...new Set(
            (raw.skills ?? existing.skills)
              .map((item) => String(item ?? '').trim())
              .filter((item) => item !== ''),
          ),
        ]
      : [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

let writeChain = Promise.resolve()
let mutationChain = Promise.resolve()

function serializeWrite(task) {
  const run = writeChain.then(task)
  writeChain = run.catch(() => {})
  return run
}

/** Serialize a whole read-modify-write of the plugin stores, so two concurrent
 * saves cannot drop one another's update. */
function withMutation(task) {
  const run = mutationChain.then(task)
  mutationChain = run.catch(() => {})
  return run
}

async function quarantineCorrupt(file, error) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.rename(file, `${file}.corrupt-${stamp}`)
  } catch {
    /* keep the original file when it cannot be moved */
  }
  try {
    console.warn(`dsh-agent-skill: ${file} is not valid JSON (${error?.message ?? error}); kept as .corrupt-*`)
  } catch {
    /* ignore */
  }
}

async function readAgentStore() {
  let text
  try {
    text = await fs.readFile(agentsFile(), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    const list = Array.isArray(parsed?.agents) ? parsed.agents : []
    const rank = (agent) => (Number.isFinite(agent.order) ? agent.order : Number.MAX_SAFE_INTEGER)
    return list
      .filter((agent) => agent && typeof agent.name === 'string' && agent.name !== '')
      .map((agent) => ({
        ...agent,
        skills: Array.isArray(agent.skills) ? agent.skills : [],
        tools: Array.isArray(agent.tools) && agent.tools.length > 0 ? agent.tools : null,
        mode: agent.mode === 'fork' ? 'fork' : 'spawn',
        maxDepth: Number.isFinite(agent.maxDepth) ? agent.maxDepth : 1,
      }))
      .sort((a, b) => rank(a) - rank(b))
  } catch (error) {
    await quarantineCorrupt(agentsFile(), error)
    return []
  }
}

async function writeAgentStore(agents) {
  await serializeWrite(async () => {
    const file = agentsFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({ version: 1, agents }, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, payload, 'utf8')
    await fs.rename(temporary, file)
  })
}

/* ---------------------------------------------------------- skill bindings */

function emptyBindings() {
  return { version: 1, bindings: {}, order: {} }
}

async function readBindings() {
  let text
  try {
    text = await fs.readFile(bindingsFile(), 'utf8')
  } catch {
    return emptyBindings()
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    const bindings = parsed?.bindings
    if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) return emptyBindings()
    const order =
      parsed?.order !== null && typeof parsed?.order === 'object' && !Array.isArray(parsed.order)
        ? parsed.order
        : {}
    return { version: 1, bindings, order }
  } catch (error) {
    await quarantineCorrupt(bindingsFile(), error)
    return emptyBindings()
  }
}

async function writeBindings(state) {
  await serializeWrite(async () => {
    const file = bindingsFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload = JSON.stringify(state, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, payload, 'utf8')
    await fs.rename(temporary, file)
  })
}

function sessionsOfBinding(binding) {
  const ids = new Set()
  for (const entry of binding?.workspaces ?? []) {
    for (const id of entry?.sessions ?? []) {
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  return [...ids]
}

/* ------------------------------------------------------------------ skills */

async function collectSkills(ctx) {
  const { roots, projectRoots } = allSkillRoots(ctx)
  const state = await readBindings()
  const bindings = state.bindings
  const order = state.order ?? {}
  const byName = new Map()

  const absorb = (skill) => {
    if (!skill) return
    const previous = byName.get(skill.name)
    if (previous === undefined) {
      const binding = bindings[skill.name]
      byName.set(skill.name, {
        ...skill,
        binding: binding === undefined ? undefined : presentBinding(binding),
      })
      return
    }
    // Project definitions outrank user/global ones, matching the shipped
    // filesystem provider's rank (project-dsh 100 … user-dsh 400 … user-agents 500).
    previous.alternates = [...(previous.alternates ?? []), skill.path]
  }

  for (const entry of projectRoots) {
    const skills = await scanSkillRoot(entry.root, {
      scope: 'project',
      workspace: { path: entry.workspace.path, title: entry.workspace.title },
      projectRoot: entry.projectRoot,
    })
    for (const skill of skills) absorb(skill)
  }
  for (const entry of roots) {
    const skills = await scanSkillRoot(entry.root, { scope: 'global' })
    for (const skill of skills) absorb({ ...skill, workspaceName: '全局' })
  }

  // Managed copies back the skills bound to individual conversations.
  for (const [name, binding] of Object.entries(bindings)) {
    if (byName.has(name)) continue
    const file = path.join(managedSkillDir(name), 'SKILL.md')
    const skill = await readSkillFile(file)
    if (!skill) continue
    byName.set(name, {
      ...skill,
      scope: 'project',
      source: 'managed',
      writable: true,
      workspacePath: undefined,
      workspaceName: (binding.workspaces ?? []).map((entry) => entry.title ?? entry.path).join(', '),
      binding: presentBinding(binding),
    })
  }

  const rank = (name) => (Number.isFinite(order[name]) ? order[name] : Number.MAX_SAFE_INTEGER)
  return [...byName.values()].sort((a, b) => {
    const left = rank(a.name)
    const right = rank(b.name)
    if (left !== right) return left - right
    return a.name.localeCompare(b.name)
  })
}

function presentBinding(binding) {
  return {
    scope: binding.scope === 'global' ? 'global' : 'project',
    workspaces: (binding.workspaces ?? []).map((entry) => ({
      path: entry.path,
      title: entry.title,
      root: entry.root,
      mode: entry.mode === 'sessions' ? 'sessions' : 'workspace',
      sessions: Array.isArray(entry.sessions) ? entry.sessions : [],
    })),
    sessions: sessionsOfBinding(binding),
    managed: binding.managed === true,
    files: Array.isArray(binding.files) ? binding.files : [],
    updatedAt: binding.updatedAt,
  }
}

function sessionSkillText(ctx, sessionId) {
  const bindings = cachedBindings
  if (bindings === undefined) return ''
  const parts = []
  let budget = MAX_INJECTED_SKILL_CHARS
  for (const [name, binding] of Object.entries(bindings)) {
    if (!sessionsOfBinding(binding).includes(sessionId)) continue
    const cached = cachedSkillBodies.get(name)
    if (cached === undefined || cached === '') continue
    const header = `## 技能：${name}`
    const text = cached.length > budget ? `${cached.slice(0, budget)}\n…(技能正文过长，已截断)` : cached
    budget -= text.length
    parts.push(`${header}\n${text}`)
    if (budget <= 0) break
  }
  if (parts.length === 0) return ''
  return [
    '这个会话绑定了下面的技能。它们定义了你处理这类任务的标准做法，属于硬性要求，在相关任务上按此执行。',
    '',
    parts.join('\n\n---\n\n'),
  ].join('\n')
}

/* Cached binding + body snapshots for the synchronous prompt section. */
let cachedBindings
let cachedSkillBodies = new Map()

async function refreshSkillCache(ctx) {
  const bindings = (await readBindings()).bindings
  const bodies = new Map()
  for (const skill of await collectSkills(ctx)) bodies.set(skill.name, skill.content)
  cachedBindings = bindings
  cachedSkillBodies = bodies
}

/* -------------------------------------------------------------- llm models */

/** Short-lived catalog caches: the panel refetches after every save, and both
 * lookups can reach a provider adapter or the session database. */
const MODEL_CACHE_MS = 30_000
const SESSION_CACHE_MS = 5_000
let modelCache = { at: 0, value: [] }
let sessionCache = { at: 0, value: [] }

async function collectModels(ctx, options = {}) {
  if (options.fresh !== true && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.value
  const out = []
  const llm = useService(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function') return out
  let providers = []
  try {
    providers = llm.listProviders() || []
  } catch {
    return out
  }
  for (const provider of providers) {
    const entry = { id: provider.id, name: provider.name || provider.id, models: [] }
    try {
      const models = (await llm.listModels(provider.id)) || []
      for (const model of models) {
        entry.models.push({
          id: model.id,
          name: model.name || model.id,
          description: model.description,
        })
      }
    } catch {
      /* provider without an advertised catalog */
    }
    out.push(entry)
  }
  modelCache = { at: Date.now(), value: out }
  return out
}

function collectToolNames(ctx) {
  const tools = useService(ctx, 'tools')
  if (!tools) return []
  const names = new Set()
  const absorb = (value) => {
    if (!value) return
    if (Array.isArray(value)) {
      for (const item of value) absorb(item)
      return
    }
    if (typeof value === 'string') {
      names.add(value)
      return
    }
    if (typeof value === 'object' && typeof value.name === 'string') names.add(value.name)
  }
  for (const attempt of [() => tools.definitions(undefined), () => tools.schemas(undefined)]) {
    try {
      absorb(attempt())
    } catch {
      /* method shape differs */
    }
  }
  names.delete(TOOL_NAME)
  return [...names].sort()
}

function workspaceForCwd(workspaces, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const key = canonicalKey(cwd)
  const exact = workspaces.find((workspace) => canonicalKey(workspace.path) === key)
  if (exact !== undefined) return exact
  return workspaces.find((workspace) => key.startsWith(canonicalKey(workspace.path) + path.sep))
}

async function listSessions(ctx, workspaces, options = {}) {
  if (options.fresh !== true && Date.now() - sessionCache.at < SESSION_CACHE_MS) return sessionCache.value
  const rows = []
  const seen = new Set()
  const query = useService(ctx, 'sessionQuery')
  let records = []
  if (query && typeof query.listSessions === 'function') {
    try {
      records = (await query.listSessions()) || []
    } catch {
      records = []
    }
  }
  const ordered = records
    .filter((record) => record?.header?.id !== undefined)
    // A subagent session is a delegated worker, never a conversation a user
    // picks a project skill for.
    .filter((record) => record.header.origin !== 'subagent')
    .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
    .slice(0, MAX_LISTED_SESSIONS)

  const titles = new Map()
  if (query && typeof query.readTitleSnapshots === 'function' && ordered.length > 0) {
    try {
      const results = await query.readTitleSnapshots(
        ordered.slice(0, MAX_TITLED_SESSIONS).map((record) => record.header.id),
      )
      for (const result of results || []) {
        if (result?.status === 'fulfilled' && result.value?.title?.title) {
          titles.set(result.sessionId ?? result.value.session?.id, result.value.title.title)
        }
      }
    } catch {
      /* titles are optional */
    }
  }

  for (const record of ordered) {
    const id = record.header.id
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    const cwd = record.header.cwd
    const workspace = workspaceForCwd(workspaces, cwd)
    rows.push({
      id,
      title: titles.get(id) || id.slice(0, 8),
      cwd: cwd ?? undefined,
      workspacePath: workspace?.path,
      live: record.live === true,
      createdAt: record.header.createdAt,
      origin: record.header.origin,
    })
  }

  // Live agents whose session is not in the durable corpus yet.
  const agentsService = useService(ctx, 'agents')
  if (agentsService && typeof agentsService.list === 'function') {
    let agents = []
    try {
      agents = agentsService.list() || []
    } catch {
      agents = []
    }
    const workingDirectory = useService(ctx, 'workingDirectory')
    for (const agent of agents) {
      const session = agent?.session
      const id = session?.id ?? session?.header?.id ?? agent?.id
      if (typeof id !== 'string' || id === '' || seen.has(id)) continue
      if (session?.header?.origin === 'subagent') continue
      seen.add(id)
      let cwd
      try {
        cwd = workingDirectory?.get?.(session)
      } catch {
        cwd = undefined
      }
      const workspace = workspaceForCwd(workspaces, cwd)
      rows.push({
        id,
        title: titles.get(id) || session?.header?.title || id.slice(0, 8),
        cwd: cwd ?? undefined,
        workspacePath: workspace?.path,
        live: true,
        createdAt: session?.header?.createdAt,
      })
    }
  }

  sessionCache = { at: Date.now(), value: rows }
  return rows
}

/* ------------------------------------------------------- child tool rules */

const MAX_CHILD_RULES = 200

async function readChildRules() {
  try {
    const text = await fs.readFile(childrenFile(), 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    const children = parsed?.children
    if (children === null || typeof children !== 'object' || Array.isArray(children)) return {}
    return children
  } catch {
    return {}
  }
}

function pruneChildRules(children) {
  const entries = Object.entries(children)
    .filter(([id, record]) => typeof id === 'string' && id !== '' && record !== null && typeof record === 'object')
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, MAX_CHILD_RULES)
  return Object.fromEntries(entries)
}

async function writeChildRules(children) {
  await serializeWrite(async () => {
    const file = childrenFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const payload = JSON.stringify({ version: 1, children: pruneChildRules(children) }, null, 2)
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, payload, 'utf8')
    await fs.rename(temporary, file)
  })
}

/* ------------------------------------------------------------ child prompt */

function buildChildPrompt({ agent, skills, task }) {
  const blocks = []
  if (agent.systemPrompt !== '') blocks.push(agent.systemPrompt)
  if (skills.length > 0) {
    const header = [
      `在开始前，先完整读取并严格遵循下面 ${skills.length} 份技能指令。它们定义了你处理这类任务的标准做法，属于硬性要求。`,
      '',
    ].join('\n')
    let budget = MAX_INJECTED_SKILL_CHARS
    const rendered = []
    for (const skill of skills) {
      const body =
        skill.content.length > budget ? `${skill.content.slice(0, budget)}\n…(技能正文过长，已截断)` : skill.content
      budget -= body.length
      rendered.push(`## 技能：${skill.name}\n${skill.description}\n\n${body}`)
      if (budget <= 0) break
    }
    blocks.push(`${header}${rendered.join('\n\n---\n\n')}`)
  }
  blocks.push(`# 任务\n${task}`)
  return blocks.join('\n\n=====\n\n')
}

/* ------------------------------------------------------------------ apply */

export const name = PLUGIN_ID
export const inject = ['webServer', 'tools', 'subagents']

export function apply(ctx) {
  /** childId -> { allow: Set<string> | null, label: string } */
  const childRules = new Map()
  /** childId -> disposer of the scope tool restriction */
  const restrictionDisposers = new Map()
  /** agentId -> () => void  (session-scoped skill section) */
  const sessionSections = new Map()
  let toolDisposer
  let currentAgents = []

  const logWarn = (message) => {
    try {
      ctx.logger?.warn?.(`${PLUGIN_ID}: ${message}`)
    } catch {
      /* logging is best effort */
    }
  }

  const persistChildRule = async (childId, rule) => {
    try {
      const children = await readChildRules()
      children[childId] = {
        allow: rule.allow === null ? null : [...rule.allow],
        label: rule.label,
        at: Date.now(),
      }
      await writeChildRules(children)
    } catch (error) {
      logWarn(`could not persist child rule: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const dropChildRule = async (childId) => {
    childRules.delete(childId)
    try {
      const children = await readChildRules()
      if (children[childId] !== undefined) {
        delete children[childId]
        await writeChildRules(children)
      }
    } catch {
      /* the in-memory rule is already gone */
    }
  }

  const loadChildRules = async () => {
    const children = await readChildRules()
    for (const [childId, record] of Object.entries(children)) {
      if (typeof childId !== 'string' || childId === '' || record === null || typeof record !== 'object') continue
      const allow =
        record.allow === null || record.allow === undefined
          ? null
          : new Set((Array.isArray(record.allow) ? record.allow : []).map(String))
      childRules.set(childId, { allow, label: String(record.label ?? 'subagent') })
    }
  }

  const allowedRootsForSkills = () => {
    const { roots, projectRoots } = allSkillRoots(ctx)
    return [...roots, ...projectRoots].map((entry) => canonicalKey(entry.root))
  }

  /* --------------------------------------------------------------- routes */

  const handleState = async (request, response) => {
    if (!methodAllowed(request, response, ['GET', 'HEAD'])) return
    try {
      const url = requestUrl(request)
      const fresh = url?.searchParams.get('fresh') === '1'
      const workspaces = listWorkspaces(ctx)
      const [agents, skills, models, sessions] = await Promise.all([
        readAgentStore(),
        collectSkills(ctx),
        collectModels(ctx, { fresh }),
        listSessions(ctx, workspaces, { fresh }),
      ])
      currentAgents = agents
      sendJson(request, response, 200, {
        version: 1,
        agents,
        skills,
        models,
        sessions,
        workspaces,
        tools: collectToolNames(ctx),
        paths: {
          dshHome: resolveDshHome(),
          agentsHome: resolveAgentsHome(),
          store: storeDir(),
          globalSkills: path.join(resolveDshHome(), 'skills'),
        },
        delegate: {
          tool: TOOL_NAME,
          example: 'delegate_agent(agent: "<名称>", prompt: "<完整任务>")',
        },
      })
    } catch (error) {
      logWarn(`state failed: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(request, response, 500, { error: error instanceof Error ? error.message : 'state-failed' })
    }
  }

  const handleModel = async (request, response) => {
    if (!methodAllowed(request, response, ['GET', 'HEAD'])) return
    const url = requestUrl(request)
    const provider = url?.searchParams.get('provider') ?? ''
    const model = url?.searchParams.get('model') ?? ''
    if (provider === '' || model === '') {
      sendJson(request, response, 400, { error: 'provider-and-model-required' })
      return
    }
    const llm = useService(ctx, 'llm')
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      sendJson(request, response, 200, { provider, model, efforts: [] })
      return
    }
    try {
      const info = await llm.resolveModelInfo(provider, model)
      sendJson(request, response, 200, {
        provider,
        model,
        name: info?.name,
        contextWindow: info?.context?.contextWindow,
        defaultEffort: info?.reasoning?.defaultEffort,
        efforts: (info?.reasoning?.efforts ?? []).map((effort) => ({
          id: effort.id,
          name: effort.name || effort.id,
          description: effort.description,
        })),
      })
    } catch (error) {
      sendJson(request, response, 200, {
        provider,
        model,
        efforts: [],
        error: error instanceof Error ? error.message : 'model-unavailable',
      })
    }
  }

  const handleReadSkill = async (request, response) => {
    if (!methodAllowed(request, response, ['GET', 'HEAD'])) return
    const url = requestUrl(request)
    const target = url?.searchParams.get('path')
    if (!target) {
      sendJson(request, response, 400, { error: 'path-required' })
      return
    }
    const resolved = path.resolve(target)
    if (!isInsideAny(resolved, allowedRootsForSkills())) {
      sendJson(request, response, 403, { error: 'path-outside-skill-roots' })
      return
    }
    const skill = await readSkillFile(resolved)
    if (!skill) {
      sendJson(request, response, 404, { error: 'skill-not-found' })
      return
    }
    sendJson(request, response, 200, skill)
  }

  const handleSaveAgent = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    try {
      const result = await withMutation(async () => {
        const agents = await readAgentStore()
        const targetId = typeof body.id === 'string' ? body.id : undefined
        const existingIndex = targetId ? agents.findIndex((agent) => agent.id === targetId) : -1
        const existing = existingIndex >= 0 ? agents[existingIndex] : undefined
        const next = normalizeAgent(body, existing)
        const clash = agents.some(
          (agent, index) => index !== existingIndex && agent.name.toLowerCase() === next.name.toLowerCase(),
        )
        if (clash) throw httpError(409, 'agent-name-taken')
        if (existingIndex >= 0) agents[existingIndex] = next
        else agents.push(next)
        await writeAgentStore(agents)
        return { agent: next, agents }
      })
      currentAgents = result.agents
      syncDelegateTool()
      sendJson(request, response, 200, result)
    } catch (error) {
      const status = Number(error?.status) === 409 ? 409 : 400
      sendJson(request, response, status, { error: error instanceof Error ? error.message : 'save-failed' })
    }
  }

  const handleReorderAgents = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    try {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      const ordered = await withMutation(async () => {
        const agents = await readAgentStore()
        if (ids.length !== agents.length) throw httpError(400, 'invalid-order')
        const known = new Map(agents.map((agent) => [agent.id, agent]))
        const seen = new Set()
        const next = []
        for (const id of ids) {
          if (seen.has(id) || !known.has(id)) throw httpError(400, 'invalid-order')
          seen.add(id)
          const agent = known.get(id)
          next.push({ ...agent, order: next.length })
        }
        await writeAgentStore(next)
        return next
      })
      currentAgents = ordered
      syncDelegateTool()
      sendJson(request, response, 200, { agents: ordered })
    } catch (error) {
      const status = Number(error?.status) || 500
      sendJson(request, response, status, { error: error instanceof Error ? error.message : 'reorder-failed' })
    }
  }

  const handleDeleteAgent = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) {
      sendJson(request, response, 400, { error: 'id-required' })
      return
    }
    try {
      const agents = await withMutation(async () => {
        const next = (await readAgentStore()).filter((agent) => agent.id !== id)
        await writeAgentStore(next)
        return next
      })
      currentAgents = agents
      syncDelegateTool()
      sendJson(request, response, 200, { agents })
    } catch (error) {
      sendJson(request, response, 500, { error: error instanceof Error ? error.message : 'delete-failed' })
    }
  }

  const isSkillFileTarget = (file, name) => {
    const base = path.basename(file).toLowerCase()
    if (base === 'skill.md') return true
    return name !== '' && base === `${name}.md`
  }

  const removableRoots = () => [...allowedRootsForSkills(), canonicalKey(managedRoot())]

  const removeFiles = async (files) => {
    for (const file of files ?? []) {
      const resolved = path.resolve(file)
      const base = path.basename(resolved).toLowerCase()
      // Defense in depth: only a Markdown skill document inside a managed skill
      // root may be removed, never the plugin's own stores or bundle resources.
      if (!base.endsWith('.md')) continue
      if (!isInsideAny(resolved, removableRoots())) continue
      try {
        await fs.rm(resolved, { force: true })
        const directory = path.dirname(resolved)
        if (base === 'skill.md') {
          const left = await fs.readdir(directory).catch(() => [])
          if (left.length === 0) await fs.rmdir(directory).catch(() => {})
        }
      } catch {
        /* keep going: one stale file must not block the save */
      }
    }
  }

  const handleSaveSkill = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    try {
      const name = normalizeSkillName(body.name)
      if (!SKILL_NAME_RE.test(name)) throw httpError(400, 'invalid-skill-name')
      const description = String(body.description ?? '').trim()
      if (description === '') throw httpError(400, 'description-required')
      if (Buffer.byteLength(description, 'utf8') > MAX_SKILL_DESCRIPTION_BYTES) {
        throw httpError(400, 'description-too-long')
      }
      const whenToUse = String(body.whenToUse ?? '').trim()
      if (Buffer.byteLength(whenToUse, 'utf8') > MAX_SKILL_DESCRIPTION_BYTES) {
        throw httpError(400, 'when-to-use-too-long')
      }
      const content = String(body.content ?? '')
      const scope = body.scope === 'project' ? 'project' : 'global'
      const originalName = normalizeSkillName(body.originalName)
      const text = renderSkillFile({ name, description, whenToUse, content })
      // `readSkillFile` drops anything above this limit, so refuse to write a
      // skill the model could never discover.
      if (Buffer.byteLength(text, 'utf8') > MAX_SKILL_BYTES) throw httpError(400, 'skill-too-large')
      const workspaces = listWorkspaces(ctx)
      const knownWorkspace = new Map(
        workspaces.map((workspace) => [canonicalKey(workspace.path), workspace]),
      )

      const result = await withMutation(async () => {
        const state = await readBindings()
        const previous = originalName !== '' ? state.bindings[originalName] : state.bindings[name]
        if (originalName !== name) {
          const taken =
            state.bindings[name] !== undefined ||
            (await collectSkills(ctx)).some((skill) => skill.name === name)
          if (taken) throw httpError(409, 'duplicate-skill')
        }

        const files = []
        const selection = []
        if (scope === 'global') {
          const file = path.join(resolveDshHome(), 'skills', name, 'SKILL.md')
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, text, 'utf8')
          files.push(file)
        } else {
          const requested = Array.isArray(body.workspaces) ? body.workspaces : []
          for (const entry of requested) {
            const workspacePath = String(entry?.path ?? '').trim()
            if (workspacePath === '') continue
            const workspace = knownWorkspace.get(canonicalKey(workspacePath))
            if (workspace === undefined) throw httpError(400, 'workspace-unknown')
            const mode = entry?.mode === 'sessions' ? 'sessions' : 'workspace'
            const sessions = Array.isArray(entry?.sessions)
              ? [...new Set(entry.sessions.map(String).filter((id) => id !== ''))]
              : []
            if (mode === 'sessions' && sessions.length === 0) throw httpError(400, 'session-required')
            selection.push({
              path: workspace.path,
              title: workspace.title,
              // The provider discovers project skills from the nearest `.git`
              // root, not necessarily from the workspace directory itself.
              root: workspace.projectRoot ?? workspace.path,
              mode,
              sessions: mode === 'sessions' ? sessions : [],
            })
            if (mode === 'workspace') {
              const file = path.join(workspace.projectRoot ?? workspace.path, '.dsh', 'skills', name, 'SKILL.md')
              await fs.mkdir(path.dirname(file), { recursive: true })
              await fs.writeFile(file, text, 'utf8')
              files.push(file)
            }
          }
          if (selection.length === 0) throw httpError(400, 'workspace-required')
          if (selection.some((entry) => entry.mode === 'sessions')) {
            const file = path.join(managedSkillDir(name), 'SKILL.md')
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, text, 'utf8')
            files.push(file)
          }
        }

        // Remove the files this plugin wrote for the previous revision only.
        const stale = (previous?.files ?? []).filter(
          (file) => !files.some((next) => canonicalKey(next) === canonicalKey(file)),
        )
        await removeFiles(stale)
        if (originalName !== '' && originalName !== name) {
          delete state.bindings[originalName]
          // Renaming keeps the card where the user dragged it.
          if (Number.isFinite(state.order[originalName])) state.order[name] = state.order[originalName]
          delete state.order[originalName]
        }
        state.bindings[name] = {
          scope,
          workspaces: selection,
          sessions: [...new Set(selection.flatMap((entry) => entry.sessions ?? []))],
          managed: files.some((file) => canonicalKey(file).startsWith(canonicalKey(managedRoot()) + path.sep)),
          files,
          updatedAt: Date.now(),
        }
        await writeBindings(state)
        return { name, files }
      })

      await refreshSkillCache(ctx)
      resyncSessionSections()
      sendJson(request, response, 200, { ...result, skills: await collectSkills(ctx) })
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status >= 500) logWarn(`skill save failed: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(request, response, status, { error: error instanceof Error ? error.message : 'write-failed' })
    }
  }

  const handleDeleteSkill = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    const name = normalizeSkillName(body.name)
    const explicitPath = typeof body.path === 'string' && body.path.trim() !== '' ? path.resolve(body.path) : ''
    try {
      const removed = await withMutation(async () => {
        const state = await readBindings()
        const binding = name !== '' ? state.bindings[name] : undefined
        const targets = new Set()
        // Only the file the user actually confirmed is a candidate from the
        // request; same-named skills in other roots stay untouched.
        if (explicitPath !== '') {
          if (!isSkillFileTarget(explicitPath, name)) throw httpError(400, 'invalid-delete-target')
          if (!isInsideAny(explicitPath, removableRoots())) throw httpError(403, 'path-outside-skill-roots')
          targets.add(explicitPath)
        }
        for (const file of binding?.files ?? []) targets.add(file)
        if (name !== '') {
          delete state.bindings[name]
          delete state.order[name]
          await writeBindings(state)
        }
        await removeFiles([...targets])
        return [...targets]
      })
      await refreshSkillCache(ctx)
      resyncSessionSections()
      sendJson(request, response, 200, { removed, skills: await collectSkills(ctx) })
    } catch (error) {
      const status = Number(error?.status) || 500
      logWarn(`skill delete failed: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(request, response, status, { error: error instanceof Error ? error.message : 'delete-failed' })
    }
  }

  const handleReorderSkills = async (request, response) => {
    if (!methodAllowed(request, response, ['POST'])) return
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(request, response, 400, { error: error instanceof Error ? error.message : 'invalid-json' })
      return
    }
    try {
      const names = Array.isArray(body.names) ? body.names.map((value) => normalizeSkillName(value)) : []
      const order = await withMutation(async () => {
        const state = await readBindings()
        const current = (await collectSkills(ctx)).map((skill) => skill.name)
        if (names.length !== current.length) throw httpError(400, 'invalid-order')
        const known = new Set(current)
        const seen = new Set()
        const next = {}
        for (const name of names) {
          if (seen.has(name) || !known.has(name)) throw httpError(400, 'invalid-order')
          seen.add(name)
          next[name] = Object.keys(next).length
        }
        state.order = next
        await writeBindings(state)
        return next
      })
      sendJson(request, response, 200, { order, skills: await collectSkills(ctx) })
    } catch (error) {
      const status = Number(error?.status) || 500
      sendJson(request, response, status, { error: error instanceof Error ? error.message : 'reorder-failed' })
    }
  }

  const fenced = (handler) => async (request, response) => {
    if (!isAllowed(ctx, request)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    try {
      await handler(request, response)
    } catch (error) {
      logWarn(`route failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!response.headersSent) {
        sendJson(request, response, 500, {
          error: error instanceof Error ? error.message : 'internal-error',
        })
      }
    }
  }

  const webServer = useService(ctx, 'webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => {
      const disposers = [
        webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: fenced(handleState) }),
        webServer.register({ kind: 'exact', path: MODEL_ROUTE, handler: fenced(handleModel) }),
        webServer.register({ kind: 'exact', path: SKILL_ROUTE, handler: fenced(handleReadSkill) }),
        webServer.register({ kind: 'exact', path: AGENT_SAVE_ROUTE, handler: fenced(handleSaveAgent) }),
        webServer.register({ kind: 'exact', path: AGENT_DELETE_ROUTE, handler: fenced(handleDeleteAgent) }),
        webServer.register({ kind: 'exact', path: AGENT_REORDER_ROUTE, handler: fenced(handleReorderAgents) }),
        webServer.register({ kind: 'exact', path: SKILL_SAVE_ROUTE, handler: fenced(handleSaveSkill) }),
        webServer.register({ kind: 'exact', path: SKILL_DELETE_ROUTE, handler: fenced(handleDeleteSkill) }),
        webServer.register({ kind: 'exact', path: SKILL_REORDER_ROUTE, handler: fenced(handleReorderSkills) }),
      ]
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  } else {
    logWarn('webServer is unavailable; the panel will not load')
  }

  /* ------------------------------------------------- session-scoped skills */

  const sessionSectionBody = (agent) => {
    const id = agent?.id ?? agent?.session?.id
    if (typeof id !== 'string' || id === '') return ''
    return sessionSkillText(ctx, id)
  }

  const dropSessionSection = (agentId) => {
    const dispose = sessionSections.get(agentId)
    if (dispose === undefined) return
    sessionSections.delete(agentId)
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }

  const syncSessionSection = (agent) => {
    const id = agent?.id ?? agent?.session?.id
    if (typeof id !== 'string' || id === '') return
    dropSessionSection(id)
    if (sessionSectionBody(agent) === '') return
    try {
      const systemPrompt = agent?.ctx ? (agent.ctx.get?.('systemPrompt', false) ?? agent.ctx.systemPrompt) : undefined
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return
      const dispose = agent.ctx.effect(() =>
        systemPrompt.section({
          name: SECTION_NAME,
          order: 940,
          text: () => sessionSectionBody(agent),
        }),
      )
      if (typeof dispose === 'function') sessionSections.set(id, dispose)
    } catch (error) {
      logWarn(`session skill section failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function resyncSessionSections() {
    const agentsService = useService(ctx, 'agents')
    if (!agentsService || typeof agentsService.list !== 'function') return
    let agents = []
    try {
      agents = agentsService.list() || []
    } catch {
      return
    }
    for (const agent of agents) syncSessionSection(agent)
  }

  /* ------------------------------------------------------ tool restriction */

  const applyChildRestriction = (agent, rule) => {
    if (rule.allow === null || rule.allow.size === 0) return
    const id = agent?.id ?? agent?.session?.id
    if (typeof id === 'string' && restrictionDisposers.has(id)) return
    try {
      const tools = agent?.ctx?.get?.('tools', false) ?? agent?.ctx?.tools
      if (!tools || typeof tools.restrict !== 'function') return
      const known = new Set(collectToolNames(ctx))
      const allow = [...rule.allow].filter((name) => known.has(name) || name === TOOL_NAME)
      if (allow.length === 0) return
      const dispose = agent.ctx.effect(() => tools.restrict({ allow }))
      if (typeof dispose === 'function' && typeof id === 'string') restrictionDisposers.set(id, dispose)
    } catch (error) {
      logWarn(`tool restriction failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const resyncChildRestrictions = () => {
    const agentsService = useService(ctx, 'agents')
    if (!agentsService || typeof agentsService.list !== 'function') return
    let agents = []
    try {
      agents = agentsService.list() || []
    } catch {
      return
    }
    for (const agent of agents) {
      const rule = childRules.get(agent?.id ?? agent?.session?.id)
      if (rule !== undefined) applyChildRestriction(agent, rule)
    }
  }

  try {
    if (typeof ctx.tools?.guard === 'function') {
      ctx.effect(() =>
        ctx.tools.guard((exec) => {
          const agent = exec?.agent
          const key = agent?.id ?? agent?.session?.id
          if (key === undefined) return undefined
          const rule = childRules.get(key)
          if (rule === undefined) return undefined
          if (rule.allow === null) return undefined
          const name = typeof exec?.name === 'string' ? exec.name : exec?.schema?.name
          if (name === undefined || name === TOOL_NAME) return undefined
          if (rule.allow.has(name)) return undefined
          return `工具 ${name} 不在子智能体「${rule.label}」的允许清单中。按清单内的工具完成任务，或在回复里说明缺什么。`
        }),
      )
    }
  } catch (error) {
    logWarn(`tool guard registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  /* ------------------------------------------------------ agent lifecycle */

  try {
    ctx.on('agent/created', ({ agent }) => {
      const rule = childRules.get(agent?.id)
      if (rule !== undefined) applyChildRestriction(agent, rule)
      syncSessionSection(agent)
    })
  } catch (error) {
    logWarn(`agent lifecycle listener failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => () => {
    for (const dispose of sessionSections.values()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    sessionSections.clear()
    for (const dispose of restrictionDisposers.values()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    restrictionDisposers.clear()
    childRules.clear()
  })

  /* -------------------------------------------------------- delegate tool */

  const startDelegation = async (args, exec) => {
    const parent = exec?.agent
    if (parent === undefined) throw new Error('delegate_agent 需要一个调用方 agent')

    const agents = currentAgents.length > 0 ? currentAgents : await readAgentStore()
    const wanted = String(args?.agent ?? '').trim()
    const definition =
      agents.find((agent) => agent.name === wanted) ??
      agents.find((agent) => agent.name.toLowerCase() === wanted.toLowerCase())
    if (definition === undefined) {
      throw new Error(
        agents.length === 0
          ? '还没有定义任何子智能体。请在「Agent & Skill」面板里先创建一个。'
          : `没有名为 "${wanted}" 的子智能体。可用：${agents.map((agent) => agent.name).join('、')}`,
      )
    }

    const task = String(args?.prompt ?? '').trim()
    if (task === '') throw new Error('`prompt` 不能为空')

    const allSkills = await collectSkills(ctx)
    const selected = definition.skills
      .map((name) => allSkills.find((skill) => skill.name === name))
      .filter((skill) => skill !== undefined)

    const prompt = buildChildPrompt({ agent: definition, skills: selected, task })

    const provider = definition.mode === 'fork' ? 'fork' : 'spawn'
    const subagents = useService(ctx, 'subagents')
    if (!subagents || typeof subagents.startActivation !== 'function') {
      throw new Error('subagent 服务不可用，无法委派')
    }
    if (typeof subagents.getProvider === 'function' && subagents.getProvider(provider) === undefined) {
      throw new Error(`subagent 后端 "${provider}" 未注册；请检查 profile 中的 spawn/fork provider`)
    }

    const agentOptions =
      definition.provider !== undefined && definition.model !== undefined
        ? {
            provider: definition.provider,
            model: definition.model,
            ...(definition.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: definition.reasoningEffort }),
          }
        : undefined

    const label = definition.displayName || definition.name
    const allow = definition.tools === null || definition.tools === undefined ? null : new Set(definition.tools)
    const rule = { allow, label }
    // Reserve the child identity and register its rule BEFORE the activation:
    // `agent/created` listeners are awaited before creation resolves, so a rule
    // written after `startActivation` returns would never reach the child's
    // model-facing tool set. The rule also outlives the activation because local
    // spawn/fork children stay resumable for later messages.
    const childId = randomUUID()
    childRules.set(childId, rule)
    await persistChildRule(childId, rule)

    const resolvedDepth =
      typeof subagents.resolveMaxDepth === 'function'
        ? subagents.resolveMaxDepth(definition.maxDepth ?? 1)
        : (definition.maxDepth ?? 1)

    let activation
    try {
      activation = await subagents.startActivation({
        provider,
        label,
        childId,
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal: exec.signal,
          ...(args?.cwd === undefined ? {} : { cwd: String(args.cwd) }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
          ...(resolvedDepth === undefined ? {} : { maxDepth: resolvedDepth }),
        },
        signal: exec.signal,
        delivery: 'parent',
      })
    } catch (error) {
      await dropChildRule(childId)
      throw error
    }

    if (activation.childId !== childId) {
      childRules.delete(childId)
      childRules.set(activation.childId, rule)
      try {
        const children = await readChildRules()
        delete children[childId]
        children[activation.childId] = { allow: allow === null ? null : [...allow], label, at: Date.now() }
        await writeChildRules(children)
      } catch {
        /* the in-memory rule still covers this process */
      }
    }

    // Backstop for a backend that publishes the child before the listener sees
    // it; the listener normally installed the restriction already.
    try {
      const agentsService = useService(ctx, 'agents')
      const childAgent = agentsService?.get?.(activation.childId)
      if (childAgent) applyChildRestriction(childAgent, childRules.get(activation.childId) ?? rule)
    } catch {
      /* not fatal: the guard still denies out-of-list tools */
    }

    return activation.childId
  }

  const buildDelegateDefinition = () => {
    const agents = currentAgents
    const names = agents.map((agent) => agent.name)
    const described = agents.map((agent) => {
      const route = agent.model ? `${agent.provider ?? 'default'}/${agent.model}` : 'inherited'
      const skills = agent.skills.length > 0 ? `; skills: ${agent.skills.join(', ')}` : ''
      const tools = agent.tools === null ? '' : `; tools: ${agent.tools.join(', ')}`
      return `- ${agent.name}${agent.displayName && agent.displayName !== agent.name ? ` (${agent.displayName})` : ''} [${agent.mode}, ${route}${skills}${tools}]${agent.description ? `: ${agent.description}` : ''}`
    })
    return {
      name: TOOL_NAME,
      description:
        'Delegate work to one of the user-defined subagents created in the Agent & Skill sidebar panel. It starts an independently managed child and returns its id; the runtime notifies you when the child finishes. Pick `agent` by its configured name.\n\n' +
        (described.length === 0
          ? 'No subagents are defined yet; do the work directly.'
          : `Available subagents:\n${described.join('\n')}`),
      // `tools.register()` takes a raw tool definition, so `parameters` has to be
      // a complete JSON Schema object. The author-facing shorthand
      // (`{ agent: { type, required, … } }`) is only accepted by `defineTool()`,
      // which compiles it first — shipping the shorthand verbatim makes the
      // provider reject the whole schema (`parameters.description` is an object,
      // not a string) and fails every turn that offers this tool.
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            ...(names.length === 0 ? {} : { enum: names }),
            description: 'Name of the subagent to run.',
          },
          description: {
            type: 'string',
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            description:
              'The complete task for the child. A fresh spawn child does not see this conversation, so the prompt must stand alone.',
          },
          cwd: {
            type: 'string',
            description: 'Initial child working directory. Relative paths use your current directory; omitted inherits it.',
          },
        },
        required: ['agent', 'prompt'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return startDelegation(args, exec)
      },
    }
  }

  function syncDelegateTool() {
    const tools = useService(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    try {
      if (typeof toolDisposer === 'function') {
        toolDisposer()
        toolDisposer = undefined
      }
      toolDisposer = tools.register(buildDelegateDefinition())
    } catch (error) {
      logWarn(`delegate tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => () => {
    if (typeof toolDisposer === 'function') {
      try {
        toolDisposer()
      } catch {
        /* ignore */
      }
    }
    toolDisposer = undefined
  })

  /* -------------------------------------------------------------- startup */

  void (async () => {
    currentAgents = await readAgentStore()
    await loadChildRules()
    resyncChildRestrictions()
    try {
      await refreshSkillCache(ctx)
    } catch {
      /* the cache refreshes on the next save */
    }
    syncDelegateTool()
    resyncSessionSections()
    try {
      ctx.logger?.info?.(`${PLUGIN_ID}: ready (${currentAgents.length} agents, store ${storeDir()})`)
    } catch {
      /* ignore */
    }
  })()
}
