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
  model: '/api/dsh-agent-skill/model',
  skill: '/api/dsh-agent-skill/skill',
  agentSave: '/api/dsh-agent-skill/agents/save',
  agentDelete: '/api/dsh-agent-skill/agents/delete',
  skillSave: '/api/dsh-agent-skill/skills/save',
  skillDelete: '/api/dsh-agent-skill/skills/delete',
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

let root
let previousDshHome
let harness
let workspaceA
let workspaceB

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh-agent-skill-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'dsh-home')
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
  assert.deepEqual(spec.request.agentOptions, {
    provider: 'fake-provider',
    model: 'fake-model',
    reasoningEffort: 'low',
  })
  assert.equal(spec.request.maxDepth, 1)
  const prompt = spec.request.prompt[0].text
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
  assert.equal(harness.state.activation.request.agentOptions, undefined)
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
    assert.equal(harness.state.activation.request.maxDepth, 0)
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
