/**
 * The resident-schema budget for this plugin's tool surface.
 *
 * Every JSON Schema a plugin registers is paid for in the model's context on every turn, so the
 * size of the surface is a cost, not an implementation detail. This script prints what each tool
 * costs and what the surface costs in total, and fails when the total crosses the budget below —
 * which is how a well-meaning extra argument gets noticed before it is paid for forever.
 *
 * Run it with `npm run surface`.
 *
 * @module dsh-tts/bin/surface-report
 */
import { toolDefinitions } from '../tools/index.mjs'

/** The resident surface budget in bytes, measured as `JSON.stringify(definition).length`. */
const BUDGET_BYTES = 24_000

/** A logger that prints nothing: nothing here should write to the model's transcript. */
const quietLogger = { info() {}, warn() {}, error() {} }

const definitions = toolDefinitions({ provider: 'edge' }, quietLogger)
const rows = definitions.map((definition) => ({
  tool: definition.name,
  bytes: JSON.stringify(definition).length,
  actions: definition.parameters?.properties?.action?.enum?.length ?? 0,
  properties: Object.keys(definition.parameters?.properties ?? {}).length,
}))
const total = rows.reduce((sum, row) => sum + row.bytes, 0)

const pad = (value, width) => String(value).padEnd(width)
console.log(`${pad('tool', 14)}${pad('bytes', 9)}${pad('actions', 9)}properties`)
for (const row of rows) console.log(`${pad(row.tool, 14)}${pad(row.bytes, 9)}${pad(row.actions, 9)}${row.properties}`)
console.log(`${pad('total', 14)}${pad(total, 9)}budget ${BUDGET_BYTES} (${((total / BUDGET_BYTES) * 100).toFixed(1)}%)`)

if (total > BUDGET_BYTES) {
  console.error(`\nresident surface is ${total - BUDGET_BYTES} bytes over budget: shorten a description or move it into tts_guide`)
  process.exitCode = 1
}
