/**
 * The public core of `dsh-tts`, for a caller that wants the capability without the tools.
 *
 * The CLI (`src/bin/tts.mjs`) and the test suite both import from here, which is what keeps the
 * tool layer thin: everything below this line can be exercised without a host.
 *
 * @module dsh-tts/core
 */
export { TtsError } from './errors.mjs'
export {
  PROVIDER_IDS,
  chooseProvider,
  createProviders,
  providerStatuses,
  resolveProvider,
  speakRequest,
} from './providers/index.mjs'
export {
  DEFAULT_VOICE,
  EDGE_DEFAULTS,
  TRUSTED_CLIENT_TOKEN,
  audioBodyOffset,
  buildSsml,
  edgeTimestamp,
  escapeXml,
  lastWordEnd,
  parseVoiceList,
  parseWordBoundaries,
  secMsGec,
  voicesUrl,
} from './providers/edge.mjs'
export { commandProvider, fillPlaceholders, parseTimingsFile, placeholdersIn } from './providers/command.mjs'
export {
  buildWordsDocument,
  DEFAULT_AUDIO_NAME,
  DEFAULT_OUT_DIR,
  readWordsFile,
  resolveAudioPath,
  resolveOutDir,
  wordsPathFor,
  writeAudioFile,
  writeJson,
  writeSidecar,
  writeSpeech,
} from './output.mjs'
export { dialogueDocument, parseScript, planTimeline, verifyClips } from './dialogue.mjs'
export { PLUGIN_ROOT, SIBLINGS_ROOT, ffprobeCandidates, findFfprobe, probeDurationSeconds, sharedFfmpegState } from './probe.mjs'
export {
  HOME_DIR_NAME,
  HOME_ENV,
  SHARED_FFMPEG_BIN,
  SHARED_FFMPEG_DIR,
  SHARED_LIB_DIR,
  SHARED_MATTE_DIR,
  SHARED_MODELS_DIR,
  SHARED_OCR_DIR,
  SHARED_ROOT,
  SHARED_RUNTIME_DIR,
  SHARED_YAMNET_DIR,
  binaryName,
  sharedHomeState,
  sharedPath,
} from './home.mjs'
