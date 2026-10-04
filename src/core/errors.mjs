/**
 * The one error type this plugin raises for a request it refuses or an engine that failed.
 *
 * There is a single class on purpose. A tool failure is read by a model that has to decide what
 * to do next, so what matters is the message — which engine, which argument, which file — and not
 * the class hierarchy. Every message therefore names the provider and the remedy.
 *
 * @module dsh-tts/core/errors
 */

/** Raised when speech cannot be produced, or a provider is asked for something it cannot do. */
export class TtsError extends Error {
  /**
   * @param {string} message - what went wrong, in the language the caller reads.
   */
  constructor(message) {
    super(message)
    this.name = 'TtsError'
  }
}
