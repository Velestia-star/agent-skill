/**
 * Host-half tests for dsh-agent-skill.
 *
 * `apply()` is driven with a stub Cordis context: a fake web server captures the
 * route handlers, and stub services provide workspaces, sessions, models, tools
 * and the subagent registry. Every test writes into its own temporary DSH_HOME,
 * so the real profile is never touched.
 *
 * Run with `node --test test/` (Node 20+).
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'

const plugin = await import(new URL('../index.js', import.meta.url))

const ROUTES = {
  state: '/api/dsh-agent-skill/state',
  team: '/api/dsh-agent-skill/team',
  model: '/api/dsh-agent-skill/model',
  skill: '/api/dsh-agent-skill/skill',
  agentSave: '/api/dsh-agent-skill/agents/save',
  agentDelete: '/api/dsh-agent-skill/agents/delete',
  agentArrange: '/api/dsh-agent-skill/agents/arrange',
  skillSave: '/api/dsh-agent-skill/skills/save',
  skillDelete: '/api/dsh-agent-skill/skills/delete',
  skillArrange: '/api/dsh-agent-skill/skills/arrange',
}

/** Wait for the plugin's asynchronous startup pass. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

function makeHarness({ workspaces = [], sessions = [], liveAgents = [] } = {}) {
  const state = {
    routes: new Map(),
    listeners: new Map(),
    effects: [],
    tools: new Map(),
    guards: [],
    warnings: [],
    activation: undefined,
    section: undefined,
    commands: new Map(),
    teamNodes: [],
    teamCatalog: {},
    teamError: false,
    traceRoot: null,
    traceAncestors: [],
  }

  const services = {
    webServer: {
      register(route) {
        state.routes.set(route.path, route.handler)
        return () => state.routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => state.tools.delete(definition.name)
      },
      guard(guard) {
        state.guards.push(guard)
        return () => {}
      },
      definitions() {
        return [...state.tools.values()]
      },
      schemas() {
        return [...state.tools.values()]
      },
    },
    subagents: {
      getProvider: () => ({ name: 'spawn' }),
      resolveMaxDepth: (configured) => configured,
      startActivation: async (spec) => {
        state.activation = spec
        return {
          childId: spec.childId ?? 'child-smoke-1',
          result: Promise.resolve({ stopReason: 'completed', output: [] }),
          dispose: async () => {},
        }
      },
    },
    commands: {
      register(definition) {
        state.commands.set(definition.name, definition)
        return () => state.commands.delete(definition.name)
      },
    },
    connection: {
      requestRejection({ headers }) {
        const host = String(headers.host ?? '')
        const loopbackHost = /^(127(\.|:)|localhost(:|$)|\[::1\](:|$))/.test(host)
        const paired = String(headers.cookie ?? '').includes('paired=1')
        if (!loopbackHost && !paired) return 403
        if (headers['x-forwarded-for'] !== undefined) return 403
        if (headers['sec-fetch-site'] === 'cross-site') return 403
        const origin = headers.origin
        if (origin !== undefined) {
          try {
            if (new URL(origin).host !== host) return 403
          } catch {
            return 403
          }
        }
        return undefined
      },
    },
    workspaceRegistry: { list: () => workspaces },
    sessionQuery: {
      listSessions: async () =>
        sessions.map((session) => ({
          header: {
            id: session.id,
            cwd: session.cwd,
            createdAt: session.createdAt ?? 1_700_000_000_000,
          },
          live: false,
          persisted: true,
        })),
      readTitleSnapshots: async (ids) =>
        ids.map((id) => ({
          sessionId: id,
          status: 'fulfilled',
          value: { session: { id }, title: { title: `title:${id}` } },
        })),
      traceSession: async (sessionId) => {
        const rootId = state.traceRoot ?? sessionId
        return {
          target: { header: { id: sessionId } },
          ancestors: state.traceAncestors.map((id) => ({ header: { id } })),
          descendants: [],
          complete: true,
          root: { header: { id: rootId } },
        }
      },
      observeSession: async (sessionId) => {
        if (state.teamError) throw new Error('team unavailable')
        const rows = state.teamCatalog[sessionId] ?? state.teamNodes
        return {
          projections: { values: { subagentCatalog: rows } },
          [Symbol.dispose]: () => {},
        }
      },
    },
    llm: {
      listProviders: () => [{ id: 'fake-provider', name: 'Fake Provider' }],
      listModels: async () => [{ id: 'fake-model', name: 'Fake Model' }],
      resolveModelInfo: async () => ({
        name: 'Fake Model',
        context: { contextWindow: 128_000 },
        reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
      }),
    },
    agents: { list: () => liveAgents },
    workingDirectory: { get: () => undefined },
  }

  const ctx = {
    logger: { info() {}, warn: (...args) => state.warnings.push(args.join(' ')) },
    get: (service) => services[service],
    effect(fn) {
      const disposer = fn()
      const run = typeof disposer === 'function' ? disposer : () => {}
      state.effects.push(run)
      return run
    },
    on(event, listener) {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {}
    },
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined)) callback(ctx)
      return () => {}
    },
    commands: services.commands,
    tools: services.tools,
  }

  return { ctx, state, services }
}

function makeRequest({ method = 'GET', url = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:60800', ...headers }
  stream.socket = { remoteAddress }
  stream.destroy = () => {}
  return stream
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    ended: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
      this.ended = true
    },
  }
}

async function call(state, pathName, options = {}) {
  const [routePath] = pathName.split('?')
  const handler = state.routes.get(routePath)
  assert.ok(handler, `route ${routePath} is registered`)
  const request = makeRequest({ url: pathName, ...options })
  const response = makeResponse()
  await handler(request, response)
  let json
  try {
    json = response.body === '' ? undefined : JSON.parse(response.body)
  } catch {
    json = undefined
  }
  return { status: response.statusCode, body: response.body, json }
}

const post = (state, route, payload) =>
  call(state, route, {
    method: 'POST',
    url: route,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

const postEmpty = (state, route) =>
  call(state, route, {
    method: 'POST',
    url: route,
    headers: { 'content-type': 'application/json' },
    body: undefined,
  })

/**
 * One isolated store (and harness) per test. `boot()` starts a second harness
 * against the same DSH_HOME, which is how the persistence tests prove the order
 * survives a fresh process. Every temporary directory is removed in `t.after`.
 */
async function isolatedHarness(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-agent-skill-order-'))
  const previous = process.env.DSH_HOME
  const previousAgentsHome = process.env.DSH_AGENTS_HOME
  const home = path.join(dir, 'dsh-home')
  process.env.DSH_HOME = home
  process.env.DSH_AGENTS_HOME = path.join(dir, 'agents-home')
  const disposers = []

  const boot = async (bootOptions = options) => {
    const instance = makeHarness(bootOptions)
    plugin.apply(instance.ctx)
    await settle()
    disposers.push(() => {
      for (const dispose of instance.state.effects) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    })
    return instance
  }

  const instance = await boot(options)
  t.after(async () => {
    for (const dispose of disposers.splice(0).reverse()) dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = previousAgentsHome
    await rm(dir, { recursive: true, force: true })
  })
  return { ...instance, boot, dir, home }
}

const agentIds = (state) => state.json.agents.map((agent) => agent.id)
const agentNames = (state) => state.json.agents.map((agent) => agent.name)
const skillNames = (state) => state.json.skills.map((skill) => skill.name)
const agentsStoreFile = (box) => path.join(box.home, 'agent-skill', 'agents.json')
const skillsStoreFile = (box) => path.join(box.home, 'agent-skill', 'skills.json')

async function createAgent(box, name) {
  const saved = await post(box.state, ROUTES.agentSave, { name })
  assert.equal(saved.status, 200, `agent ${name} saved`)
  return saved.json.agent
}

async function createSkill(box, name) {
  const saved = await post(box.state, ROUTES.skillSave, {
    name,
    description: `${name} description.`,
    content: `Body of ${name}.`,
    scope: 'global',
  })
  assert.equal(saved.status, 200, `skill ${name} saved`)
  return saved.json
}

let root
let previousDshHome
let previousAgentsHome
let harness
let workspaceA
let workspaceB

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-agent-skill-'))
  previousDshHome = process.env.DSH_HOME
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = path.join(root, 'dsh-home')
  process.env.DSH_AGENTS_HOME = path.join(root, 'agents-home')
  workspaceA = path.join(root, 'workspace-a')
  workspaceB = path.join(root, 'workspace-b')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceB, { recursive: true })
  harness = makeHarness({
    workspaces: [
      { path: workspaceA, title: 'Alpha' },
      { path: workspaceB, title: 'Beta' },
    ],
    sessions: [
      { id: 'session-alpha', cwd: workspaceA, createdAt: 1_700_000_000_000 },
      { id: 'session-beta', cwd: path.join(workspaceB, 'nested'), createdAt: 1_700_000_100_000 },
    ],
  })
  plugin.apply(harness.ctx)
  await settle()
})

after(async () => {
  for (const dispose of harness?.state.effects ?? []) {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  if (root) await rm(root, { recursive: true, force: true })
})

test('state route reports agents, skills, models, tools, workspaces and sessions', async () => {
  const { status, json } = await call(harness.state, ROUTES.state)
  assert.equal(status, 200)
  assert.deepEqual(json.agents, [])
  assert.deepEqual(json.skills, [])
  assert.equal(json.models[0].id, 'fake-provider')
  assert.equal(json.models[0].models[0].id, 'fake-model')
  assert.deepEqual(json.workspaces.map((workspace) => workspace.title), ['Alpha', 'Beta'])
  assert.equal(json.sessions.length, 2)
  assert.equal(json.sessions.find((session) => session.id === 'session-alpha').workspacePath, workspaceA)
  assert.equal(json.sessions.find((session) => session.id === 'session-beta').workspacePath, workspaceB)
  assert.equal(json.sessions.find((session) => session.id === 'session-alpha').title, 'title:session-alpha')
  assert.equal(json.paths.globalSkills, path.join(root, 'dsh-home', 'skills'))
  assert.ok(json.tools.includes('delegate_agent') === false, 'delegate_agent is hidden from the tool picker')
})

test('team route returns the running and idle members of the conversation tree', async () => {
  harness.state.traceRoot = null
  harness.state.rootTitle = 'Root conversation'
  harness.state.teamNodes = [
    {
      id: 'child-a',
      parentId: 'session-alpha',
      depth: 1,
      path: 'lead/worker',
      kind: 'child',
      activity: 'running',
      mode: 'continuable',
      label: '研发主管',
      hasChildren: true,
    },
    {
      id: 'child-b',
      parentId: 'child-a',
      depth: 2,
      kind: 'child',
      activity: 'inactive',
      mode: 'one-shot',
      label: '执行体',
      hasChildren: false,
    },
    {
      id: 'child-c',
      parentId: 'session-alpha',
      depth: 1,
      kind: 'diagnostic',
      activity: 'inactive',
      reason: 'corrupt',
    },
  ]
  const { status, json } = await call(harness.state, `${ROUTES.team}?sessionId=session-alpha`)
  assert.equal(status, 200)
  assert.equal(json.rootId, 'session-alpha')
  assert.equal(json.currentId, 'session-alpha')
  assert.deepEqual(json.trail, ['session-alpha'])
  assert.equal(json.nodes.length, 3)
  assert.equal(json.nodes[0].activity, 'running')
  assert.equal(json.nodes[0].label, '研发主管')
  assert.equal(json.nodes[1].activity, 'inactive')
  assert.equal(json.nodes[2].kind, 'diagnostic')
  assert.equal(json.nodes[2].reason, 'corrupt')
  assert.equal(json.truncated, false)
  harness.state.teamNodes = []
})

test('team route maps the catalog createdAt onto each node', async () => {
  harness.state.traceRoot = null
  harness.state.teamNodes = [
    {
      id: 'child-started',
      activity: 'inactive',
      mode: 'continuable',
      label: '执行体',
      createdAt: 1_700_000_123_456,
    },
    {
      id: 'child-unstarted',
      activity: 'inactive',
      mode: 'one-shot',
      label: '执行体',
    },
  ]
  const { status, json } = await call(harness.state, `${ROUTES.team}?sessionId=session-alpha`)
  assert.equal(status, 200)
  assert.equal(json.nodes.length, 2)
  assert.equal(json.nodes[0].createdAt, 1_700_000_123_456)
  assert.equal(json.nodes[1].createdAt, undefined)
  harness.state.teamNodes = []
})

test('team route validates the session id, fence and descendant failures', async () => {
  const missing = await call(harness.state, ROUTES.team)
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error, 'session-required')

  const crossOrigin = await call(harness.state, `${ROUTES.team}?sessionId=session-alpha`, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossOrigin.status, 403)

  harness.state.teamError = true
  const failed = await call(harness.state, `${ROUTES.team}?sessionId=session-alpha`)
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error, 'team-unavailable')
  harness.state.teamError = false
})

test('team route expands one branch on demand', async () => {
  harness.state.traceRoot = null
  harness.state.teamCatalog = {
    'child-a': [
      { id: 'grand-1', activity: 'running', mode: 'continuable', label: '执行体' },
    ],
  }
  const { status, json } = await call(
    harness.state,
    `${ROUTES.team}?sessionId=session-alpha&parentId=child-a`,
  )
  assert.equal(status, 200)
  assert.equal(json.parentId, 'child-a')
  assert.equal(json.rootId, 'session-alpha')
  assert.equal(json.nodes.length, 1)
  assert.equal(json.nodes[0].id, 'grand-1')
  assert.equal(json.nodes[0].parentId, 'child-a')
  assert.equal(json.nodes[0].activity, 'running')
  harness.state.teamCatalog = {}
})

test('team route returns the root-to-current trail in order', async () => {
  harness.state.traceRoot = 'root-session'
  harness.state.traceAncestors = ['mid-session', 'root-session']
  const { status, json } = await call(harness.state, `${ROUTES.team}?sessionId=child-session`)
  assert.equal(status, 200)
  assert.deepEqual(json.trail, ['root-session', 'mid-session', 'child-session'])
  harness.state.traceRoot = null
  harness.state.traceAncestors = []
})

test('team route traces a child conversation back to its root', async () => {
  harness.state.traceRoot = 'root-session'
  harness.state.teamNodes = []
  const { status, json } = await call(harness.state, `${ROUTES.team}?sessionId=child-session`)
  assert.equal(status, 200)
  assert.equal(json.rootId, 'root-session')
  assert.equal(json.currentId, 'child-session')
  assert.deepEqual(json.trail, ['root-session', 'child-session'])
  harness.state.traceRoot = null
})

test('model route resolves reasoning efforts for one exact route', async () => {
  const { status, json } = await call(
    harness.state,
    `${ROUTES.model}?provider=fake-provider&model=fake-model`,
  )
  assert.equal(status, 200)
  assert.equal(json.contextWindow, 128_000)
  assert.deepEqual(json.efforts, [{ id: 'low', name: 'Low' }])
  assert.equal(json.defaultEffort, 'low')
})

test('agent save validates names and refuses duplicates', async () => {
  const empty = await post(harness.state, ROUTES.agentSave, { name: '   ' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'agent-name-required')

  const noProvider = await post(harness.state, ROUTES.agentSave, { name: 'broken', model: 'fake-model' })
  assert.equal(noProvider.status, 400)
  assert.equal(noProvider.json.error, 'model-provider-required')

  const created = await post(harness.state, ROUTES.agentSave, {
    name: 'reviewer',
    displayName: 'Reviewer',
    description: 'checks diffs',
    mode: 'spawn',
    provider: 'fake-provider',
    model: 'fake-model',
    reasoningEffort: 'low',
    tools: ['read', 'grep'],
    skills: ['smoke-skill'],
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.agent.name, 'reviewer')
  assert.deepEqual(created.json.agent.tools, ['grep', 'read'])

  const duplicate = await post(harness.state, ROUTES.agentSave, { name: 'Reviewer' })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.json.error, 'agent-name-taken')

  const stored = JSON.parse(await readFile(path.join(root, 'dsh-home', 'agent-skill', 'agents.json'), 'utf8'))
  assert.equal(stored.agents.length, 1)
  assert.equal(stored.agents[0].name, 'reviewer')

  const removed = await post(harness.state, ROUTES.agentDelete, { id: created.json.agent.id })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json.agents, [])
})

test('global skill save writes a SKILL.md under the global root', async () => {
  const saved = await post(harness.state, ROUTES.skillSave, {
    name: 'smoke-skill',
    description: 'Smoke skill used by the tests.',
    whenToUse: 'During tests only.',
    content: '# Rule\n\nReply exactly: PONG',
    scope: 'global',
  })
  assert.equal(saved.status, 200)
  const file = path.join(root, 'dsh-home', 'skills', 'smoke-skill', 'SKILL.md')
  await stat(file)
  assert.deepEqual(saved.json.files, [file])
  const text = await readFile(file, 'utf8')
  assert.match(text, /^---\nname: "smoke-skill"\n/m)
  assert.match(text, /description: "Smoke skill used by the tests\."/)
  assert.match(text, /whenToUse: "During tests only\."/)
  assert.match(text, /Reply exactly: PONG/)

  const state = await call(harness.state, ROUTES.state)
  const skill = state.json.skills.find((entry) => entry.name === 'smoke-skill')
  assert.equal(skill.scope, 'global')
  assert.equal(skill.source, 'filesystem')
  assert.equal(skill.binding.scope, 'global')
})

test('invalid skill names and missing descriptions are rejected', async () => {
  const badName = await post(harness.state, ROUTES.skillSave, { name: '中文名', description: 'x' })
  assert.equal(badName.status, 400)
  assert.equal(badName.json.error, 'invalid-skill-name')

  const noDescription = await post(harness.state, ROUTES.skillSave, { name: 'ok-name' })
  assert.equal(noDescription.status, 400)
  assert.equal(noDescription.json.error, 'description-required')

  const noWorkspace = await post(harness.state, ROUTES.skillSave, {
    name: 'project-empty',
    description: 'x',
    scope: 'project',
    workspaces: [],
  })
  assert.equal(noWorkspace.status, 400)
  assert.equal(noWorkspace.json.error, 'workspace-required')
})

test('project skill in workspace mode lands in the workspace skill root', async () => {
  const saved = await post(harness.state, ROUTES.skillSave, {
    name: 'project-skill',
    description: 'A project skill.',
    content: 'Use the project skill.',
    scope: 'project',
    workspaces: [{ path: workspaceA, mode: 'workspace', sessions: [] }],
  })
  assert.equal(saved.status, 200)
  const file = path.join(workspaceA, '.dsh', 'skills', 'project-skill', 'SKILL.md')
  await stat(file)
  assert.deepEqual(saved.json.files, [file])

  const state = await call(harness.state, ROUTES.state)
  const skill = state.json.skills.find((entry) => entry.name === 'project-skill')
  assert.equal(skill.scope, 'project')
  assert.equal(skill.workspacePath, workspaceA)
  assert.deepEqual(skill.binding.workspaces[0].mode, 'workspace')
})

test('conversation-scoped skill stays managed and injects only bound sessions', async () => {
  const saved = await post(harness.state, ROUTES.skillSave, {
    name: 'session-skill',
    description: 'Only for one conversation.',
    content: 'SESSION RULE: preface every reply with ORBIT.',
    scope: 'project',
    workspaces: [{ path: workspaceB, mode: 'sessions', sessions: ['session-beta'] }],
  })
  assert.equal(saved.status, 200)
  const managed = path.join(root, 'dsh-home', 'agent-skill', 'managed-skills', 'session-skill', 'SKILL.md')
  await stat(managed)
  assert.deepEqual(saved.json.files, [managed])
  await assert.rejects(stat(path.join(workspaceB, '.dsh', 'skills', 'session-skill', 'SKILL.md')))

  const state = await call(harness.state, ROUTES.state)
  const skill = state.json.skills.find((entry) => entry.name === 'session-skill')
  assert.equal(skill.source, 'managed')
  assert.deepEqual(skill.binding.sessions, ['session-beta'])

  // A bound conversation receives the instructions as a per-agent prompt section.
  const sections = []
  const agentCtx = {
    get: (service) =>
      service === 'systemPrompt'
        ? {
            section(definition) {
              sections.push(definition)
              return () => {}
            },
          }
        : undefined,
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  for (const listener of harness.state.listeners.get('agent/created') ?? []) {
    await listener({ agent: { id: 'session-beta', ctx: agentCtx } })
  }
  assert.equal(sections.length, 1)
  assert.match(sections[0].text(), /SESSION RULE: preface every reply with ORBIT\./)

  // An unbound conversation gets nothing.
  sections.length = 0
  for (const listener of harness.state.listeners.get('agent/created') ?? []) {
    await listener({ agent: { id: 'session-alpha', ctx: agentCtx } })
  }
  assert.equal(sections.length, 0)
})

test('delegating a spawn agent injects the attached skill and honours the route', async () => {
  const tool = harness.state.tools.get('delegate_agent')
  assert.ok(tool, 'delegate_agent is registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.agent.type, 'string')
  assert.deepEqual(tool.parameters.required, ['agent', 'prompt'])

  const saved = await post(harness.state, ROUTES.agentSave, {
    name: 'pong-runner',
    mode: 'spawn',
    provider: 'fake-provider',
    model: 'fake-model',
    reasoningEffort: 'low',
    skills: ['smoke-skill'],
  })
  assert.equal(saved.status, 200)

  const childId = await tool.execute(
    { agent: 'pong-runner', prompt: 'Do the thing.' },
    { agent: { id: 'parent-session' }, signal: new AbortController().signal },
  )
  assert.match(childId, /^[0-9a-f-]{36}$/)
  const spec = harness.state.activation
  assert.equal(spec.childId, childId)
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.parent.id, 'parent-session')
  assert.deepEqual(spec.agentOptions, {
    provider: 'fake-provider',
    model: 'fake-model',
    reasoningEffort: 'low',
  })
  assert.equal(spec.maxDepth, 1)
  const prompt = spec.prompt[0].text
  assert.match(prompt, /Reply exactly: PONG/)
  assert.match(prompt, /Do the thing\./)

  await assert.rejects(
    tool.execute(
      { agent: 'nobody', prompt: 'x' },
      { agent: { id: 'parent-session' }, signal: new AbortController().signal },
    ),
    (error) => {
      assert.match(String(error.message), /没有名为 "nobody" 的子智能体/)
      return true
    },
  )
})

test('delegating a fork agent selects the fork backend', async () => {
  await post(harness.state, ROUTES.agentSave, { name: 'forker', mode: 'fork' })
  const tool = harness.state.tools.get('delegate_agent')
  await tool.execute(
    { agent: 'forker', prompt: 'Continue.' },
    { agent: { id: 'parent-session' }, signal: new AbortController().signal },
  )
  assert.equal(harness.state.activation.provider, 'fork')
  assert.equal(harness.state.activation.agentOptions, undefined)
})

test('a subagent answers to its display name and to a unique prefix', async () => {
  const saved = await post(harness.state, ROUTES.agentSave, {
    name: 'chief-of-staff',
    displayName: '幕僚长',
    description: 'Coordinates the team.',
  })
  assert.equal(saved.status, 200)
  const tool = harness.state.tools.get('delegate_agent')
  const run = (agent) =>
    tool.execute(
      { agent, prompt: 'x' },
      { agent: { id: 'parent-session' }, signal: new AbortController().signal },
    )

  await run('chief')
  assert.equal(harness.state.activation.label, '幕僚长')
  await run('CHIEF')
  assert.equal(harness.state.activation.label, '幕僚长')
  await run('幕僚长')
  assert.equal(harness.state.activation.label, '幕僚长')

  // An ambiguous prefix names both candidates instead of guessing.
  const devManager = await post(harness.state, ROUTES.agentSave, { name: 'dev-manager' })
  const devOps = await post(harness.state, ROUTES.agentSave, { name: 'dev-ops' })
  await assert.rejects(run('dev'), (error) => {
    assert.match(String(error.message), /匹配到多个子智能体/)
    assert.match(String(error.message), /dev-manager/)
    assert.match(String(error.message), /dev-ops/)
    return true
  })

  await post(harness.state, ROUTES.agentDelete, { id: saved.json.agent.id })
  await post(harness.state, ROUTES.agentDelete, { id: devManager.json.agent.id })
  await post(harness.state, ROUTES.agentDelete, { id: devOps.json.agent.id })
})

test('the /chief command starts the chief subagent without a model turn', async () => {
  const saved = await post(harness.state, ROUTES.agentSave, {
    name: 'chief',
    displayName: '幕僚长',
  })
  assert.equal(saved.status, 200)

  const command = harness.state.commands.get('chief')
  assert.ok(command, '/chief is registered')
  const invoke = (rawInput) => ({
    commandId: 'cmd-1',
    agent: { id: 'parent-session' },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  })

  const started = await command.handler(invoke('把首页的保存按钮改成 loading 态'))
  assert.equal(started.kind, 'success')
  assert.match(started.text, /已交给 chief/)
  assert.match(started.text, /子会话/)
  assert.equal(harness.state.activation.provider, 'spawn')
  assert.match(harness.state.activation.prompt[0].text, /把首页的保存按钮改成 loading 态/)

  const empty = await command.handler(invoke('   '))
  assert.deepEqual(empty, { kind: 'error', text: '用法：/chief <任务>' })

  await post(harness.state, ROUTES.agentDelete, { id: saved.json.agent.id })
  const missing = await command.handler(invoke('再做一次'))
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /没有名为 "chief" 的子智能体/)
})

test('deleting a skill removes the files this plugin wrote', async () => {
  // A same-named skill in a different root is NOT owned by this panel; deleting
  // the global skill must leave it alone.
  const decoy = path.join(workspaceB, '.dsh', 'skills', 'smoke-skill', 'SKILL.md')
  await mkdir(path.dirname(decoy), { recursive: true })
  await writeFile(decoy, '---\nname: smoke-skill\ndescription: decoy\n---\nDecoy.\n', 'utf8')

  const globalFile = path.join(root, 'dsh-home', 'skills', 'smoke-skill', 'SKILL.md')
  await stat(globalFile)
  const deleted = await post(harness.state, ROUTES.skillDelete, { name: 'smoke-skill' })
  assert.equal(deleted.status, 200)
  await assert.rejects(stat(globalFile))
  await stat(decoy)

  // A delete request may not point at the plugin's own stores.
  const storeAttack = await post(harness.state, ROUTES.skillDelete, {
    name: 'smoke-skill',
    path: path.join(root, 'dsh-home', 'agent-skill', 'agents.json'),
  })
  assert.equal(storeAttack.status, 400)
  assert.equal(storeAttack.json.error, 'invalid-delete-target')

  const projectFile = path.join(workspaceA, '.dsh', 'skills', 'project-skill', 'SKILL.md')
  await stat(projectFile)
  await post(harness.state, ROUTES.skillDelete, { name: 'project-skill' })
  await assert.rejects(stat(projectFile))

  const managedFile = path.join(root, 'dsh-home', 'agent-skill', 'managed-skills', 'session-skill', 'SKILL.md')
  await post(harness.state, ROUTES.skillDelete, { name: 'session-skill' })
  await assert.rejects(stat(managedFile))

  await rm(decoy, { force: true })
  const state = await call(harness.state, ROUTES.state)
  assert.deepEqual(
    state.json.skills.map((skill) => skill.name),
    [],
    'all managed skills are gone, the unowned decoy was removed by hand',
  )
})

test('renaming a skill moves the directory and drops the old one', async () => {
  await post(harness.state, ROUTES.skillSave, {
    name: 'before-name',
    description: 'Old name.',
    content: 'Body.',
    scope: 'global',
  })
  const oldFile = path.join(root, 'dsh-home', 'skills', 'before-name', 'SKILL.md')
  await stat(oldFile)
  await post(harness.state, ROUTES.skillSave, {
    originalName: 'before-name',
    name: 'after-name',
    description: 'New name.',
    content: 'Body.',
    scope: 'global',
  })
  await assert.rejects(stat(oldFile))
  await stat(path.join(root, 'dsh-home', 'skills', 'after-name', 'SKILL.md'))
  await post(harness.state, ROUTES.skillDelete, { name: 'after-name' })
})

test('a project skill targets the nearest .git root the provider scans', async () => {
  const repo = path.join(root, 'repo')
  await mkdir(path.join(repo, '.git'), { recursive: true })
  const nested = path.join(repo, 'packages', 'app')
  await mkdir(nested, { recursive: true })
  const registry = harness.services.workspaceRegistry.list()
  registry.push({ path: nested, title: 'Nested app' })
  try {
    const state = await call(harness.state, ROUTES.state, { url: `${ROUTES.state}?fresh=1` })
    const workspace = state.json.workspaces.find((entry) => entry.path === nested)
    assert.equal(workspace.projectRoot, repo)

    const saved = await post(harness.state, ROUTES.skillSave, {
      name: 'nested-skill',
      description: 'Nested skill.',
      content: 'Body.',
      scope: 'project',
      workspaces: [{ path: nested, mode: 'workspace' }],
    })
    assert.equal(saved.status, 200)
    const file = path.join(repo, '.dsh', 'skills', 'nested-skill', 'SKILL.md')
    assert.deepEqual(saved.json.files, [file])
    await stat(file)

    await post(harness.state, ROUTES.skillDelete, { name: 'nested-skill' })
    await assert.rejects(stat(file))
  } finally {
    registry.pop()
  }
})

test('a project skill may not write outside a registered workspace', async () => {
  const escape = await post(harness.state, ROUTES.skillSave, {
    name: 'escape-skill',
    description: 'Escape attempt.',
    content: 'Body.',
    scope: 'project',
    workspaces: [{ path: path.join(root, 'not-a-workspace'), mode: 'workspace' }],
  })
  assert.equal(escape.status, 400)
  assert.equal(escape.json.error, 'workspace-unknown')
  await assert.rejects(stat(path.join(root, 'not-a-workspace', '.dsh', 'skills', 'escape-skill', 'SKILL.md')))
})

test('a new skill may not overwrite an existing name', async () => {
  const first = await post(harness.state, ROUTES.skillSave, {
    name: 'dup-check',
    description: 'First.',
    content: 'First body.',
    scope: 'global',
  })
  assert.equal(first.status, 200)
  const second = await post(harness.state, ROUTES.skillSave, {
    name: 'dup-check',
    description: 'Second.',
    content: 'Second body.',
    scope: 'global',
  })
  assert.equal(second.status, 409)
  assert.equal(second.json.error, 'duplicate-skill')
  await post(harness.state, ROUTES.skillDelete, { name: 'dup-check' })
})

test('a skill body over the provider read limit is rejected at save time', async () => {
  const big = await post(harness.state, ROUTES.skillSave, {
    name: 'too-big',
    description: 'Too big.',
    content: 'x'.repeat(49 * 1024),
    scope: 'global',
  })
  assert.equal(big.status, 400)
  assert.equal(big.json.error, 'skill-too-large')
})

test('frontmatter survives colons, hashes and boolean-looking text', async () => {
  const description = 'Reviews changes: finds regressions #1 (true)'
  const saved = await post(harness.state, ROUTES.skillSave, {
    name: 'yaml-skill',
    description,
    whenToUse: 'When: the user asks',
    content: 'Body.',
    scope: 'global',
  })
  assert.equal(saved.status, 200)
  const file = path.join(root, 'dsh-home', 'skills', 'yaml-skill', 'SKILL.md')
  const raw = await readFile(file, 'utf8')
  assert.match(raw, /description: "Reviews changes: finds regressions #1 \(true\)"/)
  const state = await call(harness.state, ROUTES.state)
  const skill = state.json.skills.find((entry) => entry.name === 'yaml-skill')
  assert.equal(skill.description, description)
  assert.equal(skill.whenToUse, 'When: the user asks')
  await post(harness.state, ROUTES.skillDelete, { name: 'yaml-skill' })
})

test('a child allowlist is registered before activation and survives the activation', async () => {
  harness.state.tools.set('read', { name: 'read', description: 'fake read tool' })
  const saved = await post(harness.state, ROUTES.agentSave, { name: 'restricted', tools: ['read'] })
  assert.deepEqual(saved.json.agent.tools, ['read'])

  const tool = harness.state.tools.get('delegate_agent')
  const childId = await tool.execute(
    { agent: 'restricted', prompt: 'x' },
    { agent: { id: 'parent-session' }, signal: new AbortController().signal },
  )
  const children = JSON.parse(
    await readFile(path.join(root, 'dsh-home', 'agent-skill', 'children.json'), 'utf8'),
  )
  assert.deepEqual(children.children[childId].allow, ['read'])

  let restriction
  const agentCtx = {
    get: (service) =>
      service === 'tools'
        ? {
            restrict(filter) {
              restriction = filter
              return () => {}
            },
          }
        : undefined,
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  for (const listener of harness.state.listeners.get('agent/created') ?? []) {
    await listener({ agent: { id: childId, ctx: agentCtx } })
  }
  assert.deepEqual(restriction.allow, ['read'])

  const guard = harness.state.guards[0]
  assert.match(guard({ agent: { id: childId }, name: 'grep' }), /不在子智能体/)
  assert.equal(guard({ agent: { id: childId }, name: 'read' }), undefined)

  // Saving `tools: null` is an explicit reset to the full tool set.
  const reset = await post(harness.state, ROUTES.agentSave, {
    id: saved.json.agent.id,
    name: 'restricted',
    tools: null,
  })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.agent.tools, null)
})

test('delegation defers the depth policy to the host resolver', async () => {
  const original = harness.services.subagents.resolveMaxDepth
  harness.services.subagents.resolveMaxDepth = () => 0
  try {
    const tool = harness.state.tools.get('delegate_agent')
    await tool.execute(
      { agent: 'forker', prompt: 'x' },
      { agent: { id: 'parent-session' }, signal: new AbortController().signal },
    )
    assert.equal(harness.state.activation.maxDepth, 0)
  } finally {
    harness.services.subagents.resolveMaxDepth = original
  }
})

test('the route fence accepts a paired remote page through the connection service', async () => {
  const paired = await call(harness.state, ROUTES.state, {
    headers: {
      host: '192.168.1.9:49803',
      origin: 'http://192.168.1.9:49803',
      cookie: 'paired=1',
    },
    remoteAddress: '192.168.1.9',
  })
  assert.equal(paired.status, 200)

  const anonymous = await call(harness.state, ROUTES.state, {
    headers: { host: '192.168.1.9:49803', origin: 'http://192.168.1.9:49803' },
    remoteAddress: '192.168.1.9',
  })
  assert.equal(anonymous.status, 403)
})

test('deleting a flat external skill removes exactly that file', async () => {
  const flat = path.join(root, 'dsh-home', 'skills', 'flat-skill.md')
  await mkdir(path.dirname(flat), { recursive: true })
  await writeFile(flat, '---\nname: flat-skill\ndescription: Flat.\n---\nBody.\n', 'utf8')
  const state = await call(harness.state, ROUTES.state)
  const skill = state.json.skills.find((entry) => entry.name === 'flat-skill')
  assert.equal(skill.path, flat)
  const deleted = await post(harness.state, ROUTES.skillDelete, { name: 'flat-skill', path: flat })
  assert.equal(deleted.status, 200)
  await assert.rejects(stat(flat))
})

test('the route fence rejects cross-origin and foreign-host requests', async () => {
  const crossOrigin = await call(harness.state, ROUTES.state, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossOrigin.status, 403)

  const foreignHost = await call(harness.state, ROUTES.state, {
    headers: { host: 'evil.example:60800' },
  })
  assert.equal(foreignHost.status, 403)

  const proxied = await call(harness.state, ROUTES.state, {
    headers: { 'x-forwarded-for': '203.0.113.7' },
  })
  assert.equal(proxied.status, 403)

  const readOutside = await call(
    harness.state,
    `${ROUTES.skill}?path=${encodeURIComponent(path.join(root, 'secret.txt'))}`,
  )
  assert.equal(readOutside.status, 403)
})

test('reads a SKILL.md only inside a managed root', async () => {
  await mkdir(path.join(root, 'dsh-home', 'skills', 'reader'), { recursive: true })
  const file = path.join(root, 'dsh-home', 'skills', 'reader', 'SKILL.md')
  await writeFile(file, '---\nname: reader\ndescription: Read me.\n---\nBody.\n', 'utf8')
  const read = await call(harness.state, `${ROUTES.skill}?path=${encodeURIComponent(file)}`)
  assert.equal(read.status, 200)
  assert.equal(read.json.content.trim(), 'Body.')
})

/* ------------------------------------------------------- arrangement tests */

test('agent arrange persists a top-level rank that a second harness reloads', async (t) => {
  const box = await isolatedHarness(t)
  const a = await createAgent(box, 'agent-a')
  const b = await createAgent(box, 'agent-b')
  const c = await createAgent(box, 'agent-c')
  const reversed = [c.id, b.id, a.id]

  const arranged = await post(box.state, ROUTES.agentArrange, { ids: reversed })
  assert.equal(arranged.status, 200)
  assert.deepEqual(agentIds(arranged), reversed)

  const after = await call(box.state, ROUTES.state)
  assert.deepEqual(agentIds(after), reversed)

  const stored = JSON.parse(await readFile(agentsStoreFile(box), 'utf8'))
  assert.deepEqual(stored.rank, reversed)
  assert.deepEqual(stored.agents.map((agent) => agent.id), reversed)
  assert.ok(stored.agents.every((agent) => agent.order === undefined), 'no per-row order is written')

  const second = await box.boot()
  const reloaded = await call(second.state, ROUTES.state)
  assert.deepEqual(agentIds(reloaded), reversed)
})

test('skill arrange persists a top-level rank that a second harness reloads', async (t) => {
  const box = await isolatedHarness(t)
  await createSkill(box, 'skill-a')
  await createSkill(box, 'skill-b')
  await createSkill(box, 'skill-c')
  const reversed = ['skill-c', 'skill-a', 'skill-b']

  const arranged = await post(box.state, ROUTES.skillArrange, { names: reversed })
  assert.equal(arranged.status, 200)
  assert.deepEqual(skillNames(arranged), reversed)

  const after = await call(box.state, ROUTES.state)
  assert.deepEqual(skillNames(after), reversed)

  const stored = JSON.parse(await readFile(skillsStoreFile(box), 'utf8'))
  assert.deepEqual(stored.rank, reversed)
  assert.equal(stored.order, undefined, 'the old order map is not written')

  const second = await box.boot()
  const reloaded = await call(second.state, ROUTES.state)
  assert.deepEqual(skillNames(reloaded), reversed)
})

test('agent arrange rejects every malformed permutation without writing', async (t) => {
  const box = await isolatedHarness(t)
  const a = await createAgent(box, 'agent-a')
  await createAgent(box, 'agent-b')
  await createSkill(box, 'cross-skill')
  const baseline = agentIds(await call(box.state, ROUTES.state))
  const beforeRaw = await readFile(agentsStoreFile(box), 'utf8')

  const cases = [
    ['missing body', undefined],
    ['non-array', { ids: 'not-an-array' }],
    ['missing item', { ids: [a.id] }],
    ['duplicate id', { ids: [a.id, a.id] }],
    ['unknown id', { ids: [a.id, 'ghost-agent'] }],
    ['cross-list skill name', { ids: [a.id, 'cross-skill'] }],
    ['non-string id', { ids: [a.id, 42] }],
  ]
  for (const [label, payload] of cases) {
    const result =
      payload === undefined ? await postEmpty(box.state, ROUTES.agentArrange) : await post(box.state, ROUTES.agentArrange, payload)
    assert.equal(result.status, 400, label)
    assert.equal(result.json.error, 'invalid-arrangement', label)
    const current = await call(box.state, ROUTES.state)
    assert.deepEqual(agentIds(current), baseline, `${label}: state order unchanged`)
    assert.equal(await readFile(agentsStoreFile(box), 'utf8'), beforeRaw, `${label}: file unchanged`)
  }

  const method = await call(box.state, ROUTES.agentArrange)
  assert.equal(method.status, 405)
})

test('skill arrange rejects every malformed permutation without writing', async (t) => {
  const box = await isolatedHarness(t)
  await createSkill(box, 'skill-a')
  await createSkill(box, 'skill-b')
  const agent = await createAgent(box, 'cross-agent')
  const baseline = skillNames(await call(box.state, ROUTES.state))
  const beforeRaw = await readFile(skillsStoreFile(box), 'utf8')

  const cases = [
    ['missing body', undefined],
    ['non-array', { names: 'not-an-array' }],
    ['missing item', { names: ['skill-a'] }],
    ['duplicate name', { names: ['skill-a', 'skill-a'] }],
    ['unknown name', { names: ['skill-a', 'ghost-skill'] }],
    ['cross-list agent id', { names: ['skill-a', agent.id] }],
    ['non-string name', { names: ['skill-a', 42] }],
  ]
  for (const [label, payload] of cases) {
    const result =
      payload === undefined ? await postEmpty(box.state, ROUTES.skillArrange) : await post(box.state, ROUTES.skillArrange, payload)
    assert.equal(result.status, 400, label)
    assert.equal(result.json.error, 'invalid-arrangement', label)
    const current = await call(box.state, ROUTES.state)
    assert.deepEqual(skillNames(current), baseline, `${label}: state order unchanged`)
    assert.equal(await readFile(skillsStoreFile(box), 'utf8'), beforeRaw, `${label}: file unchanged`)
  }

  const method = await call(box.state, ROUTES.skillArrange)
  assert.equal(method.status, 405)
})

test('renaming keeps the agent id and the skill rank position', async (t) => {
  const box = await isolatedHarness(t)
  const a = await createAgent(box, 'agent-a')
  const b = await createAgent(box, 'agent-b')
  const c = await createAgent(box, 'agent-c')
  await post(box.state, ROUTES.agentArrange, { ids: [b.id, a.id, c.id] })

  const renamedAgent = await post(box.state, ROUTES.agentSave, { id: b.id, name: 'agent-b-renamed' })
  assert.equal(renamedAgent.status, 200)
  assert.equal(renamedAgent.json.agent.id, b.id, 'agent id stays stable across a rename')
  const agentsState = await call(box.state, ROUTES.state)
  assert.deepEqual(agentNames(agentsState), ['agent-b-renamed', 'agent-a', 'agent-c'])
  assert.deepEqual(agentIds(agentsState), [b.id, a.id, c.id])
  const agentsStored = JSON.parse(await readFile(agentsStoreFile(box), 'utf8'))
  assert.deepEqual(agentsStored.rank, [b.id, a.id, c.id])

  await createSkill(box, 'skill-a')
  await createSkill(box, 'skill-b')
  await createSkill(box, 'skill-c')
  await post(box.state, ROUTES.skillArrange, { names: ['skill-c', 'skill-a', 'skill-b'] })
  const renamedSkill = await post(box.state, ROUTES.skillSave, {
    originalName: 'skill-c',
    name: 'skill-c-renamed',
    description: 'Renamed.',
    content: 'Body.',
    scope: 'global',
  })
  assert.equal(renamedSkill.status, 200)
  const skillsState = await call(box.state, ROUTES.state)
  assert.deepEqual(skillNames(skillsState), ['skill-c-renamed', 'skill-a', 'skill-b'])
  const skillsStored = JSON.parse(await readFile(skillsStoreFile(box), 'utf8'))
  assert.deepEqual(skillsStored.rank, ['skill-c-renamed', 'skill-a', 'skill-b'])
})

test('deleting the middle item keeps the relative order of the rest', async (t) => {
  const box = await isolatedHarness(t)
  const a = await createAgent(box, 'agent-a')
  const b = await createAgent(box, 'agent-b')
  const c = await createAgent(box, 'agent-c')
  await post(box.state, ROUTES.agentArrange, { ids: [b.id, a.id, c.id] })
  await post(box.state, ROUTES.agentDelete, { id: a.id })
  assert.deepEqual(agentIds(await call(box.state, ROUTES.state)), [b.id, c.id])
  assert.deepEqual(
    JSON.parse(await readFile(agentsStoreFile(box), 'utf8')).rank,
    [b.id, c.id],
  )

  await createSkill(box, 'skill-a')
  await createSkill(box, 'skill-b')
  await createSkill(box, 'skill-c')
  await post(box.state, ROUTES.skillArrange, { names: ['skill-c', 'skill-a', 'skill-b'] })
  await post(box.state, ROUTES.skillDelete, { name: 'skill-a' })
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-c', 'skill-b'])
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    ['skill-c', 'skill-b'],
  )
})

test('new agents and skills land at the end and stay there after a restart', async (t) => {
  const box = await isolatedHarness(t)
  await createAgent(box, 'agent-a')
  await createAgent(box, 'agent-b')
  await createAgent(box, 'agent-c')
  await post(box.state, ROUTES.agentArrange, { ids: agentIds(await call(box.state, ROUTES.state)).reverse() })
  const d = await createAgent(box, 'agent-d')
  assert.deepEqual(agentNames(await call(box.state, ROUTES.state)), ['agent-c', 'agent-b', 'agent-a', 'agent-d'])
  assert.equal(
    JSON.parse(await readFile(agentsStoreFile(box), 'utf8')).rank.slice(-1)[0],
    d.id,
  )

  await createSkill(box, 'skill-a')
  await createSkill(box, 'skill-b')
  await createSkill(box, 'skill-c')
  await post(box.state, ROUTES.skillArrange, { names: ['skill-c', 'skill-b', 'skill-a'] })
  await createSkill(box, 'skill-d')
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-c', 'skill-b', 'skill-a', 'skill-d'])
  assert.equal(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank.slice(-1)[0],
    'skill-d',
  )

  const second = await box.boot()
  const reloaded = await call(second.state, ROUTES.state)
  assert.deepEqual(agentNames(reloaded), ['agent-c', 'agent-b', 'agent-a', 'agent-d'])
  assert.deepEqual(skillNames(reloaded), ['skill-c', 'skill-b', 'skill-a', 'skill-d'])
})

test('invalid rank data falls back deterministically and legacy order is ignored', async (t) => {
  const box = await isolatedHarness(t)
  await mkdir(path.join(box.home, 'agent-skill'), { recursive: true })
  const agentsWithRank = {
    version: 1,
    agents: [
      { id: 'id-a', name: 'agent-a', order: 0 },
      { id: 'id-b', name: 'agent-b', order: 1 },
      { id: 'id-c', name: 'agent-c', order: 2 },
    ],
    // unknown key, duplicate key, non-string entries and a missing key: c wins
    // first, b second, a is appended in its base (array) order. The per-row
    // order is ignored.
    rank: ['id-c', 42, null, 'ghost', 'id-c', 'id-b'],
  }
  await writeFile(agentsStoreFile(box), JSON.stringify(agentsWithRank, null, 2), 'utf8')
  assert.deepEqual(agentNames(await call(box.state, ROUTES.state)), ['agent-c', 'agent-b', 'agent-a'])

  await writeFile(
    agentsStoreFile(box),
    JSON.stringify(
      {
        version: 1,
        agents: [
          { id: 'id-a', name: 'agent-a', order: 2 },
          { id: 'id-b', name: 'agent-b', order: 1 },
          { id: 'id-c', name: 'agent-c', order: 0 },
        ],
        // A rank that is not an array falls back to the agents array order.
        rank: 'not-an-array',
      },
      null,
      2,
    ),
    'utf8',
  )
  assert.deepEqual(agentNames(await call(box.state, ROUTES.state)), ['agent-a', 'agent-b', 'agent-c'])

  for (const name of ['z-skill', 'a-skill', 'm-skill']) {
    const dir = path.join(box.home, 'skills', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} description.\n---\nBody.\n`,
      'utf8',
    )
  }
  await writeFile(
    skillsStoreFile(box),
    JSON.stringify(
      {
        version: 1,
        bindings: {},
        // m first, a next, z is appended in base (alphabetical) order. The old
        // order map would have produced z, m, a and must be ignored.
        rank: ['m-skill', 7, 'm-skill', 'ghost', 'a-skill'],
        order: { 'z-skill': 0, 'm-skill': 1, 'a-skill': 2 },
      },
      null,
      2,
    ),
    'utf8',
  )
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['m-skill', 'a-skill', 'z-skill'])

  await writeFile(
    skillsStoreFile(box),
    JSON.stringify(
      { version: 1, bindings: {}, rank: 'not-an-array', order: { 'z-skill': 0, 'm-skill': 1, 'a-skill': 2 } },
      null,
      2,
    ),
    'utf8',
  )
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['a-skill', 'm-skill', 'z-skill'])
})

/* ------------------------------------------ rank upgrade from pre-rank stores */

/**
 * Skills created by an older release have bindings but no top-level `rank`:
 * the old format kept a top-level `order` map instead. These tests boot such a
 * store and then edit it, which is where the appending/renaming rules used to
 * read the incomplete rank verbatim.
 */
async function legacySkillsStore(box, names) {
  const file = skillsStoreFile(box)
  const store = JSON.parse(await readFile(file, 'utf8'))
  const order = Object.fromEntries(names.map((name, index) => [name, index]))
  await writeFile(file, JSON.stringify({ version: 1, bindings: store.bindings, order }, null, 2), 'utf8')
}

async function writeSkillsRank(box, rank) {
  const file = skillsStoreFile(box)
  const store = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...store, rank }, null, 2), 'utf8')
}

test('a legacy store without rank appends a new skill at the end', async (t) => {
  const box = await isolatedHarness(t)
  const names = ['skill-a', 'skill-b', 'skill-c']
  for (const name of names) await createSkill(box, name)
  await legacySkillsStore(box, names)
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), names)

  await createSkill(box, 'skill-d')
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), [...names, 'skill-d'])
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    [...names, 'skill-d'],
  )

  const second = await box.boot()
  assert.deepEqual(skillNames(await call(second.state, ROUTES.state)), [...names, 'skill-d'])
})

test('a legacy store without rank keeps a renamed skill in place', async (t) => {
  const box = await isolatedHarness(t)
  const names = ['skill-a', 'skill-b', 'skill-c']
  for (const name of names) await createSkill(box, name)
  await legacySkillsStore(box, names)
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), names)

  const renamed = await post(box.state, ROUTES.skillSave, {
    originalName: 'skill-c',
    name: 'skill-cc',
    description: 'Renamed.',
    content: 'Body.',
    scope: 'global',
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-a', 'skill-b', 'skill-cc'])
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    ['skill-a', 'skill-b', 'skill-cc'],
  )

  const second = await box.boot()
  assert.deepEqual(skillNames(await call(second.state, ROUTES.state)), ['skill-a', 'skill-b', 'skill-cc'])
})

test('a partial rank is completed before a new skill is appended', async (t) => {
  const box = await isolatedHarness(t)
  for (const name of ['skill-a', 'skill-b', 'skill-c']) await createSkill(box, name)
  await writeSkillsRank(box, ['skill-b'])
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-b', 'skill-a', 'skill-c'])

  await createSkill(box, 'skill-d')
  assert.deepEqual(
    skillNames(await call(box.state, ROUTES.state)),
    ['skill-b', 'skill-a', 'skill-c', 'skill-d'],
  )
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    ['skill-b', 'skill-a', 'skill-c', 'skill-d'],
  )

  const second = await box.boot()
  assert.deepEqual(
    skillNames(await call(second.state, ROUTES.state)),
    ['skill-b', 'skill-a', 'skill-c', 'skill-d'],
  )
})

test('a partial rank is completed before a delete', async (t) => {
  const box = await isolatedHarness(t)
  for (const name of ['skill-a', 'skill-b', 'skill-c']) await createSkill(box, name)
  await writeSkillsRank(box, ['skill-b'])
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-b', 'skill-a', 'skill-c'])

  const deleted = await post(box.state, ROUTES.skillDelete, { name: 'skill-c' })
  assert.equal(deleted.status, 200)
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-b', 'skill-a'])
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    ['skill-b', 'skill-a'],
  )

  const second = await box.boot()
  assert.deepEqual(skillNames(await call(second.state, ROUTES.state)), ['skill-b', 'skill-a'])
})

test('a partial rank keeps a renamed skill in place', async (t) => {
  const box = await isolatedHarness(t)
  for (const name of ['skill-a', 'skill-b', 'skill-c']) await createSkill(box, name)
  await writeSkillsRank(box, ['skill-b'])
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-b', 'skill-a', 'skill-c'])

  const renamed = await post(box.state, ROUTES.skillSave, {
    originalName: 'skill-c',
    name: 'skill-cc',
    description: 'Renamed.',
    content: 'Body.',
    scope: 'global',
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(skillNames(await call(box.state, ROUTES.state)), ['skill-b', 'skill-a', 'skill-cc'])
  assert.deepEqual(
    JSON.parse(await readFile(skillsStoreFile(box), 'utf8')).rank,
    ['skill-b', 'skill-a', 'skill-cc'],
  )

  const second = await box.boot()
  assert.deepEqual(skillNames(await call(second.state, ROUTES.state)), ['skill-b', 'skill-a', 'skill-cc'])
})
