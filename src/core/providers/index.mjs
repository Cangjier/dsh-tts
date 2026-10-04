/**
 * The provider registry: which engines this plugin can speak through, and how a request is
 * turned into one engine's parameters.
 *
 * A provider is a small object with four members, and the interface is the whole contract:
 *
 *   id                stable name, as used in `config.provider` and in `provider` arguments
 *   outputExtension   the file extension the returned audio has (`mp3`, `wav`, …)
 *   timings           'word-boundaries' | 'engine-json' | 'none' — what its timings are worth
 *   speak(request)    → {audio: Buffer, words, duration, timings, meta}
 *   voices()          → {voices, total, source?}
 *   status()          → {available, requiresNetwork, notes, …} without touching the network
 *
 * Adding an engine must not require touching the tools: `tts_speak` asks the registry for a
 * provider and resolves the request through {@link speakRequest}, so a third provider is one file
 * plus one line here.
 *
 * @module dsh-tts/core/providers
 */
import { TtsError } from '../errors.mjs'
import { PROVIDER_ID as EDGE_ID, edgeProvider } from './edge.mjs'
import { PROVIDER_ID as COMMAND_ID, commandProvider } from './command.mjs'

/** Every provider id this plugin knows, in the order the guide presents them. */
export const PROVIDER_IDS = [EDGE_ID, COMMAND_ID]

/**
 * Build the providers for one normalized config.
 *
 * The providers are built per config rather than held as module singletons, because the `command`
 * one is defined entirely by its config and two profiles may configure two different engines.
 *
 * @param {object} config - the normalized plugin config.
 * @returns {Map<string, object>} provider id to provider.
 */
export function createProviders(config) {
  return new Map([
    [EDGE_ID, edgeProvider],
    [COMMAND_ID, commandProvider(config?.command ?? null)],
  ])
}

/**
 * Resolve one provider by id.
 * @param {Map<string, object>} providers - the map from {@link createProviders}.
 * @param {string} id - the requested provider id.
 * @returns {object} the provider.
 * @throws {TtsError} when the id is unknown.
 */
export function resolveProvider(providers, id) {
  const provider = providers.get(id)
  if (provider === undefined) {
    throw new TtsError(`未知的 provider ${JSON.stringify(id)}；可用的是：${[...providers.keys()].join(', ')}`)
  }
  return provider
}

/**
 * Decide which provider a call uses.
 *
 * Order: the call's own `provider` argument, then `config.provider` (which already folded in
 * `DSH_TTS_PROVIDER`), then the first provider that is usable right now. That last fallback matters:
 * a machine with an `edge` that cannot be reached but a configured local engine should synthesize,
 * not fail with "edge is unreachable".
 *
 * @param {Map<string, object>} providers - the provider map.
 * @param {object} config - the normalized plugin config.
 * @param {string|null|undefined} requested - the `provider` argument, if the call gave one.
 * @returns {{provider: object, reason: string}} the provider and why it was chosen.
 * @throws {TtsError} when a requested provider is unknown, or none is usable.
 */
export function chooseProvider(providers, config, requested) {
  if (typeof requested === 'string' && requested !== '') {
    return { provider: resolveProvider(providers, requested), reason: 'argument' }
  }
  const configured = resolveProvider(providers, config.provider)
  if (configured.status().available) return { provider: configured, reason: 'config.provider' }
  for (const [id, provider] of providers) {
    if (id === configured.id) continue
    if (provider.status().available) return { provider, reason: `${configured.id} 不可用，回落到 ${id}` }
  }
  throw new TtsError(`没有可用的 provider：${[...providers.values()].map((p) => `${p.id}(${p.status().notes.join('; ') || '不可用'})`).join('，')}`)
}

/**
 * Turn a tool call into one provider's request.
 *
 * Voice and prosody resolution lives here so that every caller — `tts_speak`, `tts_setup check`,
 * the CLI, dialogue — resolves them the same way, and so a provider that has no concept of pitch
 * is never handed one.
 *
 * @param {object} config - the normalized plugin config.
 * @param {object} provider - the resolved provider.
 * @param {object} args - the caller's arguments: text, voice, rate, pitch, volume, timeoutMs.
 * @returns {object} the request to hand to `provider.speak`.
 */
export function speakRequest(config, provider, args) {
  const text = typeof args?.text === 'string' ? args.text : ''
  const requestedVoice = typeof args?.voice === 'string' && args.voice !== '' ? args.voice : null

  if (provider.id === EDGE_ID) {
    return {
      text,
      voice: requestedVoice ?? config.edge.voice,
      rate: typeof args?.rate === 'string' && args.rate !== '' ? args.rate : config.edge.rate,
      pitch: typeof args?.pitch === 'string' && args.pitch !== '' ? args.pitch : config.edge.pitch,
      volume: typeof args?.volume === 'string' && args.volume !== '' ? args.volume : config.edge.volume,
      timeoutMs: typeof args?.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : config.edge.timeoutMs,
    }
  }

  const fallbackVoice = config.command === null ? null : config.command.voice
  return {
    text,
    voice: requestedVoice ?? fallbackVoice ?? null,
    rate: typeof args?.rate === 'string' && args.rate !== '' ? args.rate : null,
    timeoutMs: typeof args?.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : (config.command?.timeoutMs ?? null),
  }
}

/**
 * The status of every provider, for `tts_setup {action:"status"}`.
 * @param {Map<string, object>} providers - the provider map.
 * @param {object} config - the normalized plugin config.
 * @returns {object[]} one status per provider, in {@link PROVIDER_IDS} order.
 */
export function providerStatuses(providers, config) {
  return PROVIDER_IDS.map((id) => {
    const status = providers.get(id).status()
    return { ...status, isDefault: config.provider === id }
  })
}
