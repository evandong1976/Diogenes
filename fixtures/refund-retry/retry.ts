import reducer, { type RetryAttempt, type RetryEvent, type RetryState } from './reducer.mjs'

/** Where attempt commands go. The fixture never makes payment requests. */
export interface RefundAttemptSink {
  runAttempt(attempt: number): void
}

export interface RefundRetry {
  readonly state: RetryState
  dispatch(event: RetryEvent): RetryState
}

const ATTEMPT_NUMBER: Record<RetryAttempt['$'], number> = { A1: 1, A2: 2, A3: 3 }

export function isInFlight(state: RetryState): boolean {
  return state.$ === 'SAttempt1' || state.$ === 'SAttempt2'
}

/** Feeds outcomes through the Bend reducer one at a time and forwards its attempt commands. */
export function createRefundRetry(sink: RefundAttemptSink): RefundRetry {
  let state: RetryState = { $: 'SReady' }
  return {
    get state() {
      return state
    },
    dispatch(event) {
      const next = reducer.step(state, event)
      state = next.state
      if (next.effect.$ === 'RunAttempt') sink.runAttempt(ATTEMPT_NUMBER[next.effect.n.$])
      return state
    }
  }
}
