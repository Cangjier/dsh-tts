/**
 * Where the plugin writes, and what it writes.
 *
 * ONE CONTRACT, ONE WRITER
 * ------------------------
 * Every synthesis — one utterance or one line of a dialogue — ends here, so the shape of the
 * result is defined in exactly one place. The sidecar is deliberately compatible with the reader
 * that already exists downstream: `video_narrate {action:"to_cues"}` accepts `{words: [...]}` and
 * turns it into subtitle cues, so audio produced by this plugin can be subtitled by the video
 * plugin without a translation step. Fields it does not know about are ignored, not rejected.
 *
 * WHAT THE SIDECAR SAYS ABOUT ITSELF
 * ----------------------------------
 * A consumer has to be able to tell a duration that was measured from one that was reported and
 * one that does not exist:
 *
 *   durationSeconds      null, or the provider's number (for edge: the end of the last word)
 *   durationSource       'word-boundaries' | 'engine-json' | 'ffprobe' | 'timeline' | 'unavailable'
 *   audioSeconds         the decoded length when ffprobe was available, else null
 *   tailSilenceSeconds   audioSeconds − durationSeconds when both exist — the trailing silence the
 *                        engine appended, which is what a timeline has to trim
 *
 * `tailSilenceSeconds` is only arithmetic when the two numbers mean different things. A duration
 * that came from ffprobe *is* the file length, so subtracting the file length from itself would
 * report "no trailing silence" about a file nobody measured the speech end of. The caller passes
 * `tailSilenceSeconds: null` in that case, and the distinction survives into the sidecar.
 *
 * @module dsh-tts/core/output
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { TtsError } from './errors.mjs'

/** Default directory, relative to the working directory, when nothing names one. */
export const DEFAULT_OUT_DIR = 'tts'

/** Default audio file name, chosen to match the narration contract video-factory already reads. */
export const DEFAULT_AUDIO_NAME = 'voiceover'

/**
 * The directory a call writes into.
 * @param {object} config - the normalized plugin config.
 * @param {object} args - the call's arguments; `outDir` wins.
 * @param {string} cwd - the resolved working directory.
 * @returns {string} the absolute directory.
 */
export function resolveOutDir(config, args, cwd) {
  const requested = typeof args?.outDir === 'string' && args.outDir !== '' ? args.outDir : null
  if (requested !== null) return resolve(cwd, requested)
  if (typeof config?.outDir === 'string' && config.outDir !== '') return resolve(cwd, config.outDir)
  return join(cwd, DEFAULT_OUT_DIR)
}

/**
 * The audio file path for a call.
 *
 * `outPath` wins outright; otherwise the file is `<outDir>/<name>.<extension>`, where `name`
 * defaults to `voiceover`. The extension always follows the provider, so a WAV engine cannot be
 * written into a file called `.mp3`.
 *
 * @param {object} args - the call's arguments.
 * @param {string} cwd - the working directory.
 * @param {string} outDir - the directory from {@link resolveOutDir}.
 * @param {string} extension - the provider's output extension.
 * @returns {string} the absolute audio path.
 */
export function resolveAudioPath(args, cwd, outDir, extension) {
  if (typeof args?.outPath === 'string' && args.outPath !== '') return resolve(cwd, args.outPath)
  const name = typeof args?.name === 'string' && args.name !== '' ? args.name : DEFAULT_AUDIO_NAME
  return join(outDir, `${name}.${extension}`)
}

/**
 * The sidecar path for an audio path: the same stem with `.words.json`.
 * @param {string} audioPath - the audio file.
 * @returns {string} the sidecar path.
 */
export function wordsPathFor(audioPath) {
  const extension = extname(audioPath)
  const stem = extension === '' ? audioPath : audioPath.slice(0, -extension.length)
  return `${stem}.words.json`
}

/**
 * The sidecar document.
 *
 * `words` is what downstream reads; everything else is provenance, so a file found on disk months
 * later can be traced to the engine and the parameters that produced it.
 *
 * @param {object} input - the parts of the document.
 * @returns {object} the document to write.
 */
export function buildWordsDocument(input) {
  const {
    audioPath,
    provider,
    voice = null,
    text = null,
    words = [],
    durationSeconds = null,
    durationSource,
    audioSeconds = null,
    timings = 'none',
    meta = null,
    tailSilenceSeconds: explicitTail,
  } = input
  const derivedTail =
    typeof audioSeconds === 'number' && typeof durationSeconds === 'number' && durationSeconds > 0
      ? Number((audioSeconds - durationSeconds).toFixed(3))
      : null
  const tailSilenceSeconds = explicitTail === undefined ? derivedTail : explicitTail

  return {
    audio: audioPath,
    provider,
    voice,
    text,
    duration: durationSeconds === null ? null : Number(durationSeconds.toFixed(3)),
    durationSource,
    audioSeconds: audioSeconds === null ? null : Number(audioSeconds.toFixed(3)),
    tailSilenceSeconds,
    timings,
    wordCount: words.length,
    words: words.map((word) => ({
      text: word.text,
      start: Number(word.start.toFixed(3)),
      end: Number(word.end.toFixed(3)),
    })),
    ...(meta === null ? {} : { engine: meta }),
  }
}

/**
 * Write just the audio.
 *
 * Kept separate from the sidecar because of an ordering fact that is easy to get wrong: the only
 * way to learn how long the audio really is (and therefore what belongs in the sidecar) is to ask
 * ffprobe about a file that already exists. Writing the audio first and the sidecar second is the
 * order that makes `audioSeconds` and `tailSilenceSeconds` possible at all.
 *
 * @param {string} audioPath - where the audio goes.
 * @param {Buffer} audio - the bytes.
 * @returns {{audioPath: string, bytes: number}} what was written.
 * @throws {TtsError} when there is nothing to write.
 */
export function writeAudioFile(audioPath, audio) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new TtsError(`写入失败：${basename(audioPath)} 没有任何音频字节`)
  }
  mkdirSync(dirname(audioPath), { recursive: true })
  writeFileSync(audioPath, audio)
  return { audioPath, bytes: audio.length }
}

/**
 * Write just the sidecar.
 * @param {string} wordsPath - where the sidecar goes.
 * @param {object|object[]} document - the document from {@link buildWordsDocument}.
 * @returns {string} the path written.
 */
export function writeSidecar(wordsPath, document) {
  mkdirSync(dirname(wordsPath), { recursive: true })
  writeFileSync(wordsPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' })
  return wordsPath
}

/**
 * Write the audio and its sidecar in one call.
 *
 * Both are written before either path is returned: a caller that receives a path must be able to
 * read it, so a failed sidecar write is a failed call rather than a half-result. Callers that need
 * a measurement between the two writes use {@link writeAudioFile} and {@link writeSidecar} instead.
 *
 * @param {string} audioPath - where the audio goes.
 * @param {Buffer} audio - the bytes.
 * @param {object} document - the sidecar document from {@link buildWordsDocument}.
 * @param {string} [wordsPath] - where the sidecar goes; defaults to {@link wordsPathFor}.
 * @returns {{audioPath: string, wordsPath: string, bytes: number}} what was written.
 */
export function writeSpeech(audioPath, audio, document, wordsPath = wordsPathFor(audioPath)) {
  const written = writeAudioFile(audioPath, audio)
  writeSidecar(wordsPath, document)
  return { audioPath, wordsPath, bytes: written.bytes }
}

/**
 * Write one JSON document, creating its directory.
 * @param {string} path - where to write.
 * @param {object} value - the value.
 * @returns {string} the path written.
 */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
  return path
}

/**
 * Read a sidecar back, accepting both the bare array and the document shape.
 *
 * This is the reader a test pins and a caller uses to chain a synthesis into the next step without
 * remembering which of the two shapes was written.
 *
 * @param {string} path - the sidecar path.
 * @returns {{words: object[], duration: number|null, document: object|null}} the words and duration.
 */
export function readWordsFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (Array.isArray(parsed)) return { words: parsed, duration: null, document: null }
  return { words: Array.isArray(parsed?.words) ? parsed.words : [], duration: typeof parsed?.duration === 'number' ? parsed.duration : null, document: parsed }
}
