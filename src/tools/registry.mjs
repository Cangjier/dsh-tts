/**
 * Every `tts_*` tool and action this plugin exposes, documented once.
 *
 * **This file is the single source of prose about the tool surface.** The resident JSON Schema and
 * the on-demand `tts_guide` are both derived from it, so a description that says one thing in a
 * schema and another in the guide is impossible rather than merely unlikely.
 *
 * Five rules shape what is written below:
 *
 * 1. **The resident schema carries only what choosing needs** — what the action produces, what it
 *    requires, the mistake it prevents, when it is the right call. Everything long is one
 *    `tts_guide` call away.
 * 2. **A result says which engine answered.** `provider`, `voice` and `timings` are in every
 *    synthesis result, because "why does this voice sound different today" is otherwise unanswerable.
 * 3. **No verdicts.** Whether a take sounds good, which voice suits a script and how long a pause
 *    should be are the caller's calls. The timings, the durations and the trailing silence are
 *    reported as numbers so those calls can be made.
 * 4. **Missing timings are named, never estimated.** `timings: "none"` means one cannot build
 *    word-accurate subtitles from that file. A plausible guess would be worse than the truth.
 * 5. **A capability this plugin does not have must say so.** Assembly, mixing, loudness
 *    normalisation, cue splitting and speech recognition live in neighbouring plugins, and each
 *    entry names the one that owns it.
 *
 * Field contract per action:
 *   summary   one line, what it produces or answers (shown in the schema)
 *   use       when to reach for it (shown in the schema)
 *   avoid     the mistake it prevents, or the better alternative (shown when short)
 *   required  argument names the caller must supply beyond `action`
 *   returns   the shape and meaning of the result
 *   cost      time / network / install requirement, from the code
 *   gotchas   things that silently produce a wrong-looking result
 *   example   a minimal, runnable argument object
 *   seeAlso   actions normally chained with it
 *
 * @module dsh-tts/tools/registry
 */

/**
 * The tool surface, in the order it is presented.
 * @type {string[]}
 */
export const TOOL_ORDER = ['tts_speak', 'tts_setup', 'tts_guide']

/**
 * Tool and action documentation.
 * @type {Record<string, {purpose: string, use: string[], avoid: string[], needs: string[], next: string[], actions: Record<string, object>}>}
 */
export const REGISTRY = {
  tts_speak: {
    purpose:
      'Turn text into speech with the engine named per call: one utterance, or a whole multi-speaker conversation laid out on one timeline with every word timed against it.',
    use: [
      'whenever a script has to become audio — narration, a voice note, or a podcast dialogue',
      'when the word timings matter as much as the audio, because subtitles are coming next',
      'when the same script has to be tried in two voices, two rates or two engines',
    ],
    avoid: [
      'nothing here judges how it sounds: pick the voice and the pacing yourself, and compare takes by ear',
      'it does not assemble a final mix: dialogue returns clips for sample-exact assembly, and mixing belongs to the speech tool of the sibling audio plugin',
    ],
    needs: [
      'the network for provider "edge" (no API key).',
      'config.command for provider "command" — any local engine with a command line.',
      'ffprobe only when the engine does not report its own duration.',
    ],
    next: [
      'audio_build {action:"assemble"} with the returned clips to make one track.',
      'video_narrate {action:"to_cues"} with the returned words sidecar to make subtitles.',
      'audio_measure to check the audio that came out.',
    ],
    actions: {
      speak: {
        summary:
          'synthesize one piece of text to an audio file plus a word-timing sidecar, and report which engine and voice produced it.',
        use: 'for narration, a single line, or any place one voice says one thing.',
        avoid: 'do not synthesize a whole conversation in one call: use dialogue, which keeps the speakers apart and the offsets exact.',
        required: ['text or textPath'],
        returns:
          '{ audio, wordsPath, provider, voice, durationSeconds, durationSource, audioSeconds, tailSilenceSeconds, wordCount, bytes, timings, elapsedMs }',
        cost: 'one network round trip for edge (about a second for a sentence); one process run plus temp files for command.',
        gotchas: [
          'timings:"none" means this engine reported no word boundaries — the audio is fine, but word-accurate subtitles cannot be derived from it without forced alignment.',
          'durationSeconds is the end of the last spoken word for edge, not the file length: engines append trailing silence, and tailSilenceSeconds reports how much when ffprobe could measure the file.',
          'The engine, not this plugin, decides how the text is pronounced: numbers, dates and abbreviations are read the way the engine reads them.',
          'With no outDir and no cwd, the file lands in the DSH process working directory — which is the profile directory for a mounted plugin, not your project. Pass outDir when the location matters.',
        ],
        example: { action: 'speak', text: '欢迎收听本期节目。', voice: 'zh-CN-XiaoxiaoNeural', outDir: 'narration' },
        seeAlso: ['dialogue', 'tts_setup check'],
      },
      dialogue: {
        summary:
          'synthesize a multi-speaker script line by line and lay every line on one timeline, returning the clips for assembly plus one global word-timing sidecar.',
        use: 'for a podcast, an interview reconstruction, a two-host explainer — anywhere more than one voice speaks in turn.',
        avoid: 'do not join the lines by hand: the offsets here are computed from the reported durations, and the tail silence of each line is trimmed, not stacked.',
        required: ['script or scriptPath or lines'],
        returns:
          '{ manifest, wordsPath, provider, voices, lineCount, totalSeconds, lines[], clips[], wordCount, verification{ linesChecked, linesUnchecked, everyClipWithinItsFile, violations[] }, sharedVoices[], unknownSpeakerTokens[] } — clips are exactly the argument audio_build {action:"assemble"} takes.',
        cost: 'one synthesis per line, run in sequence: a twenty-line script is twenty round trips.',
        gotchas: [
          'A line whose prefix is not in `voices` (or in `speakers`) is treated as continuation text, not as a new speaker — that is what stops "时间：十点" from inventing a speaker called "时间".',
          'Every line needs a duration. edge reports one; a local engine needs ffprobe on the machine, and without either the call refuses instead of guessing where the next line starts.',
          'Two speakers given the same voice is legal and reported in sharedVoices — it just means the conversation has one voice in it.',
          'Text before the first prefix is spoken by the first declared speaker, so a script that starts mid-sentence still produces audio.',
        ],
        example: {
          action: 'dialogue',
          script: 'host-a: 欢迎回来。\nhost-b: 今天聊聊开源语音合成。',
          voices: { 'host-a': 'zh-CN-XiaoxiaoNeural', 'host-b': 'zh-CN-YunxiNeural' },
          gapSeconds: 0.4,
          outDir: 'podcast',
        },
        seeAlso: ['speak', 'audio_build {action:"assemble"}', 'video_narrate {action:"to_cues"}'],
      },
    },
  },

  tts_setup: {
    purpose:
      'Report what this machine can synthesize with right now: which engines are usable, which voices exist, and what one real synthesis of a short phrase actually produced.',
    use: [
      'before the first synthesis on a machine, to learn which engine will answer',
      'when a voice name is rejected, to see the names the service currently offers',
      'when a provider is configured but nothing comes out, to separate a bad config from a failed engine',
    ],
    avoid: [
      'status changes nothing on disk: there is no install action here, because the engines this plugin can use are either a network endpoint or something the caller installed',
    ],
    needs: [
      'nothing for status: it reads the configuration and the filesystem, and makes no network request.',
      'the network for voices (an engine\'s catalogue) and for check with provider "edge".',
    ],
    next: [
      'tts_speak {action:"speak"} once an engine is known good.',
      'tts_guide {action:"rules"} to read what a timing is worth.',
    ],
    actions: {
      status: {
        summary:
          'report each provider\'s availability, its timing source and what it requires, plus the ffprobe that was found and the config actually in force.',
        use: 'as the first call on a new machine, and whenever a synthesis fails for an unexplained reason.',
        avoid: 'it makes no network request: it cannot prove that edge is reachable, only that it is configured — use check for that.',
        required: [],
        returns:
          '{ providers[], default {provider, voice, outDir}, ffprobe {path, source, candidates[]}, node }',
        cost: 'instant: it reads config and stats a few paths.',
        gotchas: [
          'available:true for edge means "this plugin knows how to reach it", not "the network allows it". `check` is the action that actually tries.',
          'ffprobe.source names the rule that answered — config, this plugin\'s vendor, a sibling checkout, or PATH.',
        ],
        example: { action: 'status' },
        seeAlso: ['voices', 'check'],
      },
      voices: {
        summary:
          'list the voices an engine offers, filtered by locale prefix, reported as what that engine said at that moment.',
        use: 'before pinning a voice name into config, and whenever a name stops being accepted.',
        avoid: 'do not treat the list as stable: it is the service\'s own catalogue and it changes server-side.',
        required: [],
        returns: '{ provider, source, total, locale, count, voices[{ shortName, locale, gender, friendlyName, personalities, categories }] }',
        cost: 'one HTTPS request for edge (no key); instant for command, which echoes the configured names.',
        gotchas: [
          'For provider "command" the list is only what config.command.voices declares: a command line cannot be asked what voices it has, and the result says so in `source`.',
          'A voice that is listed can still fail to synthesize if the service retires it; a rejected name comes back as the engine\'s own error.',
          'filtering is a case-insensitive prefix, so locale:"zh" also returns zh-HK and zh-TW.',
        ],
        example: { action: 'voices', provider: 'edge', locale: 'zh' },
        seeAlso: ['status', 'check'],
      },
      check: {
        summary:
          'synthesize a short phrase end to end and report what came back — bytes, word count, timings, duration, elapsed time, and the trailing silence when it can be measured.',
        use: 'to prove a machine can synthesize at all, and to get a real duration to plan a timeline around.',
        avoid: 'it is not a substitute for the script you actually want: the phrase is a health check, and it writes a file you are expected to delete.',
        required: [],
        returns:
          '{ provider, voice, timings, bytes, wordCount, durationSeconds, audioSeconds, tailSilenceSeconds, elapsedMs, audio, wordsPath, sample {first, last} }',
        cost: 'one real synthesis: a network round trip for edge, one process run for command.',
        gotchas: [
          'The default phrase is short on purpose: this is a liveness check, not a preview of a voice.',
          'tailSilenceSeconds needs ffprobe; without it the field is null even though the silence is really there.',
          'A successful check does not license the output for commercial use — see the licensing rule in tts_guide {action:"rules"}.',
        ],
        example: { action: 'check', provider: 'edge', voice: 'zh-CN-YunxiNeural' },
        seeAlso: ['status', 'tts_speak speak'],
      },
    },
  },

  tts_guide: {
    purpose:
      'The full on-demand reference for this plugin: every action with its arguments, returns, cost and pitfalls, the rules that decide what a timing is worth, and where a neighbouring plugin takes over.',
    use: [
      'when an argument or a return shape is not obvious from the schema',
      'before acting on a duration or a timing, to read how it was obtained',
      'when deciding whether this plugin or a neighbouring one owns the job',
    ],
    avoid: ['do not fetch the overview before every call: the resident schema already carries what one call needs.'],
    needs: ['nothing: pure computation over this registry'],
    next: ['the action it described'],
    actions: {
      overview: {
        summary: 'the whole surface in one page: every tool, every action, one line each, plus what is cheap and what is not.',
        use: 'once, when the plugin is new to you.',
        avoid: 'it is the longest answer here; when the action is already known, ask for that action.',
        required: [],
        returns: '{ tools[], actions[], defaults, providers[], cost }',
        cost: 'instant.',
        gotchas: ['Numbers in `measured` are labelled with where each one came from — a value measured on one machine is not a promise about yours.'],
        example: { action: 'overview' },
        seeAlso: ['tool', 'rules'],
      },
      tool: {
        summary: 'one tool in full: its purpose, when to use it and when not to, its prerequisites, next step, and every action it owns.',
        use: 'when starting to use a tool you have not used before.',
        required: ['tool'],
        returns: '{ tool, purpose, use[], avoid[], needs[], next[], actions[{name, summary, required[], returns, cost}] }',
        cost: 'instant.',
        gotchas: ['For "action", the tool name goes in `tool` and the action name in `actionName` — they are different fields on purpose.'],
        example: { action: 'tool', tool: 'tts_speak' },
        seeAlso: ['action'],
      },
      action: {
        summary: 'one action in full: parameters with their meanings and defaults, the return shape, the cost, the pitfalls and a runnable example.',
        use: 'when the tool is known but not the exact arguments.',
        required: ['actionName'],
        returns: '{ action, tool, summary, use, avoid, required[], returns, cost, gotchas[], example, seeAlso[] }',
        cost: 'instant.',
        gotchas: ['The action name goes in `actionName`, not in `action` — `action` selects this reference action.'],
        example: { action: 'action', actionName: 'dialogue' },
        seeAlso: ['tool'],
      },
      rules: {
        summary:
          'the rules that decide what a synthesis result is worth: determinism, what a duration means, which timings exist, what a missing timing costs, and the licensing boundary.',
        use: 'before acting on a duration, a timing, or a take that will be published.',
        avoid: 'do not read it as advice about quality: it is what the code makes true, including the traps.',
        required: [],
        returns: '{ rules[], traps[], measured, boundaries[] }',
        cost: 'instant.',
        gotchas: ['The traps are the failures that produce a plausible wrong result rather than an error, which is why they are separated from the rules.'],
        example: { action: 'rules' },
        seeAlso: ['overview'],
      },
    },
  },
}

/**
 * Look up one tool's documentation.
 * @param {string} name - the tool name.
 * @returns {object|undefined} the entry.
 */
export function lookupTool(name) {
  return REGISTRY[name]
}

/**
 * Look up one action's documentation, with the tool that owns it.
 * @param {string} toolName - the tool name.
 * @param {string} action - the action name.
 * @returns {{tool: string, entry: object}|undefined} the entry and its tool.
 */
export function lookupAction(toolName, action) {
  const entry = REGISTRY[toolName]?.actions?.[action]
  return entry === undefined ? undefined : { tool: toolName, entry }
}

/**
 * Find the tool that owns an action, when the action name is unambiguous.
 * @param {string} action - the action name.
 * @returns {string|null} the tool name, or null when unknown or ambiguous.
 */
export function toolOfAction(action) {
  const owners = TOOL_ORDER.filter((tool) => REGISTRY[tool].actions[action] !== undefined)
  return owners.length === 1 ? owners[0] : null
}
