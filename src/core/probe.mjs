/**
 * Finding ffprobe, and asking it how long a file is.
 *
 * ffprobe is not a dependency of this plugin — a machine that only synthesizes speech never needs
 * it, and the two plugins that already live beside this one ship a build. What it *is* needed for
 * is the one number a provider may not report: how many seconds of audio actually came out. Edge
 * says when the last word ended; a local engine usually says nothing at all, and a dialogue
 * timeline cannot be laid out without a duration.
 *
 * The discovery order is the one the sibling audio plugin uses, so a machine that is already
 * rendering video does not download a second ffmpeg:
 *
 *   config.ffprobePath → DSH_TTS_FFPROBE (folded into that field) → this plugin's
 *   vendor/ffmpeg/bin → a sibling dsh-video-audio checkout → a sibling video-factory checkout →
 *   PATH
 *
 * Every answer reports `source`, so "it works on my machine" is explainable.
 *
 * @module dsh-tts/core/probe
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This plugin's root directory, derived from this file's location. */
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The directory holding the sibling plugin checkouts, if they are there. */
export const SIBLINGS_ROOT = resolve(PLUGIN_ROOT, '..')

/** Where a sibling checkout keeps a vendored ffmpeg, newest layout first. */
const SIBLING_VENDOR_DIRS = [
  ['dsh-video-audio', 'vendor', 'ffmpeg', 'bin'],
  ['video-factory', 'vendor', 'ffmpeg', 'bin'],
]

/**
 * The candidate paths for ffprobe, in the order they are tried.
 *
 * Exported so `tts_setup {action:"status"}` can show the whole list rather than only the winner:
 * when nothing is found, what was looked for is the useful part.
 *
 * @param {string|null} configured - `config.ffprobePath`.
 * @returns {{path: string, source: string}[]} the candidates.
 */
export function ffprobeCandidates(configured = null) {
  const candidates = []
  if (typeof configured === 'string' && configured !== '') {
    candidates.push({ path: resolve(configured), source: 'config.ffprobePath' })
  }
  candidates.push({ path: join(PLUGIN_ROOT, 'vendor', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'), source: 'dsh-tts/vendor' })
  for (const parts of SIBLING_VENDOR_DIRS) {
    candidates.push({
      path: join(SIBLINGS_ROOT, ...parts, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
      source: `sibling ${parts[0]}/vendor`,
    })
  }
  candidates.push({ path: 'ffprobe', source: 'PATH' })
  return candidates
}

/**
 * The first ffprobe that exists.
 * @param {string|null} configured - `config.ffprobePath`.
 * @returns {{path: string, source: string}|null} the binary and where it came from, or null.
 */
export function findFfprobe(configured = null) {
  for (const candidate of ffprobeCandidates(configured)) {
    if (candidate.source === 'PATH') {
      // A bare name cannot be tested with existsSync; report it as the last resort and let the
      // spawn decide. Callers treat a failure as "no ffprobe", which is the same outcome.
      return candidate
    }
    if (existsSync(candidate.path)) return candidate
  }
  return null
}

/**
 * Ask ffprobe for a file's duration.
 *
 * Never throws: a missing or failing ffprobe is a missing number, not a failed synthesis, and the
 * caller reports it as `durationSource: "unavailable"` instead of losing the audio it just made.
 *
 * @param {string} filePath - the media file.
 * @param {{path: string}|null} ffprobe - the resolved binary, or null.
 * @param {number} [timeoutMs] - give up after this long; defaults to 20000.
 * @returns {Promise<{seconds: number|null, error: string|null}>} the duration, or why there is none.
 */
export function probeDurationSeconds(filePath, ffprobe, timeoutMs = 20_000) {
  if (ffprobe === null) return Promise.resolve({ seconds: null, error: 'ffprobe 不可用（未在 vendor / 同级插件 / PATH 中找到）' })
  return new Promise((settle) => {
    execFile(
      ffprobe.path,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          // The first line of stderr is the reason ("No such file or directory", "Invalid data
          // found…"); without it a failure here reads as if ffprobe were missing.
          const reason = String(stderr ?? '').trim().split('\n')[0] || error.message.split('\n')[0]
          settle({ seconds: null, error: `ffprobe 失败：${reason}` })
          return
        }
        const seconds = Number.parseFloat(String(stdout).trim())
        if (!Number.isFinite(seconds) || seconds <= 0) {
          settle({ seconds: null, error: `ffprobe 返回的时长不可用：${JSON.stringify(String(stdout).trim())}` })
          return
        }
        settle({ seconds, error: null })
      },
    )
  })
}
