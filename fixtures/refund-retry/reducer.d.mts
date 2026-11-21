// Types for the ES module that `bend reducer.bend -o reducer.mjs` generates.
export type RetryAttempt = { $: 'A1' } | { $: 'A2' } | { $: 'A3' }

export type RetryState =
  { $: 'SReady' } | { $: 'SAttempt1' } | { $: 'SAttempt2' } | { $: 'SSucceeded' } | { $: 'SFailed' }

export type RetryEvent =
  { $: 'EStart' } | { $: 'ESucceeded'; n: RetryAttempt } | { $: 'EFailed'; n: RetryAttempt }

export type RetryEffect = { $: 'NoEffect' } | { $: 'RunAttempt'; n: RetryAttempt }

export interface RetryStep {
  $: 'RetryStep'
  state: RetryState
  effect: RetryEffect
}

declare const reducer: { step(state: RetryState, event: RetryEvent): RetryStep }
export default reducer
