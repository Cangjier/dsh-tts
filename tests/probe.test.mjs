/**
 * ffprobe discovery.
 *
 * The rule being pinned: **a bare name is not evidence that a program exists.** The discovery used
 * to return `ffprobe` as its last resort without checking, so a checkout with no vendored build —
 * a fresh clone, with no sibling repositories beside it — reported `source: "PATH"` on a machine
 * where ffprobe was not installed. The lie only surfaced later, as a spawn failure in an unrelated
 * call. These tests hold the claim to what can be verified now.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffprobeCandidates, findFfprobe, findOnPath } from '../src/core/probe.mjs'

/** Run a body with an extra directory prepended to PATH, restoring PATH afterwards. */
function withPathEntry(directory, body) {
  const original = process.env.PATH
  process.env.PATH = `${directory}${process.platform === 'win32' ? ';' : ':'}${original ?? ''}`
  try {
    return body()
  } finally {
    process.env.PATH = original
  }
}

test('a name that cannot exist is not found, and nothing is claimed on its behalf', () => {
  assert.equal(findOnPath('dsh-tts-no-such-binary-9f2c41'), null)
})

test('a program that is really on PATH is found as an absolute path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-path-'))
  try {
    const name = process.platform === 'win32' ? 'dsh-tts-fake-probe.exe' : 'dsh-tts-fake-probe'
    const executable = join(directory, name)
    writeFileSync(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8')
    if (process.platform !== 'win32') chmodSync(executable, 0o755)

    withPathEntry(directory, () => {
      const found = findOnPath('dsh-tts-fake-probe')
      assert.equal(found, executable)
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the candidate list ends with a PATH entry that says whether it resolved', () => {
  const candidates = ffprobeCandidates(null)
  assert.deepEqual(candidates[candidates.length - 1].source, 'PATH')
  assert.equal(typeof candidates[candidates.length - 1].found, 'boolean')
  // Every candidate carries the flag, so a report can show what was looked for and what was there.
  assert.equal(candidates.every((candidate) => typeof candidate.found === 'boolean'), true)
  // The shared plugin home first — that is where the family installs one ffmpeg — then the
  // layouts that existed before it.
  assert.deepEqual(candidates.map((candidate) => candidate.source).slice(0, 4), [
    'shared-home',
    'dsh-tts/vendor',
    'sibling dsh-video-audio/vendor',
    'sibling video-factory/vendor',
  ])
})

test('a configured path is reported as found only when it is there', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tts-configured-'))
  try {
    const present = join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    writeFileSync(present, 'stub', 'utf8')

    const hit = ffprobeCandidates(present)[0]
    assert.deepEqual([hit.source, hit.found], ['config.ffprobePath', true])
    assert.deepEqual(findFfprobe(present), { path: present, source: 'config.ffprobePath' })

    // A configured path that is not there must not be returned as if it were.
    const missing = join(directory, 'not-here-ffprobe')
    assert.equal(ffprobeCandidates(missing)[0].found, false)
    assert.notDeepEqual(findFfprobe(missing), { path: missing, source: 'config.ffprobePath' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('with nothing configured and nothing vendored, the answer is null rather than a bare name', () => {
  // This machine may well have a sibling checkout or a real ffprobe; either way the answer must be
  // an existing path or null, never the string "ffprobe".
  const found = findFfprobe(null)
  assert.equal(found === null || found.path !== 'ffprobe', true)
  if (found !== null) assert.equal(typeof found.source, 'string')
})
