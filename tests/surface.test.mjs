/**
 * The tool surface itself: the schemas, the dispatch table and the reference.
 *
 * The registry and the schemas are two descriptions of one thing, which is exactly the kind of
 * duplication that rots. These tests are what makes the load-time checks in `defineFamilyTool`
 * meaningful: they would otherwise only fire on a machine that happened to call the tool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, apply } from '../index.mjs'
import { REGISTRY, TOOL_ORDER, toolOfAction } from '../src/tools/registry.mjs'
import { toolDefinitions, TOOL_NAMES } from '../src/tools/index.mjs'
import { createGuideActions } from '../src/tools/guide.mjs'

/** A logger that records nothing: the tests assert on results, not on chatter. */
const quietLogger = { info() {}, warn() {}, error() {} }

/** A host context good enough to mount the plugin, recording what was registered. */
function stubContext() {
  const registered = []
  return {
    registered,
    logger: { info() {}, warn() {}, error() {} },
    inject(_services, callback) {
      callback({ tools: { register: (definition) => registered.push(definition) } })
    },
  }
}

test('the tools are built in the documented order, and nothing is registered that is not documented', () => {
  const definitions = toolDefinitions(normalizeConfig({}, {}), quietLogger)
  assert.deepEqual(definitions.map((definition) => definition.name), TOOL_ORDER)
  assert.deepEqual(TOOL_NAMES, TOOL_ORDER)

  for (const definition of definitions) {
    const documented = Object.keys(REGISTRY[definition.name].actions)
    assert.deepEqual(definition.parameters.properties.action.enum, documented)
    assert.equal(definition.parameters.required.includes('action'), true)
    assert.equal(definition.parameters.additionalProperties, false)
    // The description carries the purpose, the actions and the guide hint, and nothing else.
    assert.match(definition.description, new RegExp(`Actions: ${documented.join(', ')}\\.`))
    assert.match(definition.description, /Full detail: tts_guide/)
  }
})

test('every action is reachable through exactly one tool, and an unknown one is refused', () => {
  assert.equal(toolOfAction('speak'), 'tts_speak')
  assert.equal(toolOfAction('dialogue'), 'tts_speak')
  assert.equal(toolOfAction('voices'), 'tts_setup')
  assert.equal(toolOfAction('overview'), 'tts_guide')
  assert.equal(toolOfAction('nope'), null)
})

test('dispatch goes through the declared list: a sibling tool\'s handler is unreachable', async () => {
  const definitions = toolDefinitions(normalizeConfig({}, {}), quietLogger)
  const speak = definitions.find((definition) => definition.name === 'tts_speak')
  await assert.rejects(() => speak.execute({ action: 'voices' }, { cwd: process.cwd() }), /unknown action "voices"/)
  await assert.rejects(() => speak.execute({}, { cwd: process.cwd() }), /unknown action undefined/)
})

test('mounting the plugin registers all three tools', () => {
  const ctx = stubContext()
  apply(ctx, {})
  assert.deepEqual(ctx.registered.map((definition) => definition.name), TOOL_ORDER)
})

test('a config that names an unknown provider refuses to mount rather than half-working', () => {
  const ctx = stubContext()
  apply(ctx, { provider: 'xtts' })
  assert.deepEqual(ctx.registered, [])
})

test('the guide answers for every tool and action, and refuses what does not exist', async () => {
  const config = normalizeConfig({}, {})
  const guide = createGuideActions(() => toolDefinitions(config, quietLogger))

  const overview = await guide.overview()
  assert.deepEqual(overview.tools.map((tool) => tool.name), TOOL_ORDER)
  assert.equal(overview.actions.length, Object.values(REGISTRY).reduce((sum, tool) => sum + Object.keys(tool.actions).length, 0))
  assert.deepEqual(overview.providers.map((provider) => provider.id), ['edge', 'command'])
  assert.equal(overview.boundaries.length > 0, true)

  for (const tool of TOOL_ORDER) {
    const documented = await guide.tool({ tool })
    assert.deepEqual(documented.actions.map((action) => action.name), Object.keys(REGISTRY[tool].actions))
    assert.equal(documented.properties.length > 0, true)
  }

  const dialogue = await guide.action({ actionName: 'dialogue' })
  assert.equal(dialogue.tool, 'tts_speak')
  assert.equal(dialogue.example.action, 'dialogue')

  const rules = await guide.rules()
  assert.equal(rules.rules.some((rule) => rule.id === 'licensing-boundary'), true)
  assert.equal(rules.traps.some((trap) => trap.id === 'mp3-frame-gaps'), true)
  assert.equal(typeof rules.measured.edgeTailSilenceSeconds.value, 'number')

  await assert.rejects(() => guide.tool({ tool: 'tts_nope' }), /未知工具/)
  await assert.rejects(() => guide.tool({}), /需要 "tool"/)
  await assert.rejects(() => guide.action({ actionName: 'nope' }), /无法确定|没有动作/)
  await assert.rejects(() => guide.action({}), /需要 "actionName"/)
})
