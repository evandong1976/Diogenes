import type { CurrentGraph, GraphState, GraphTransition, ProposalResult } from '../../shared/gemini'

export interface FixtureSource {
  path: string
  text: string
}

type Schema =
  | { type: 'string'; enum?: string[] }
  | { type: 'integer'; minimum: number }
  | { type: 'array'; items: Schema; minItems: number; maxItems: number }
  | {
      type: 'object'
      properties: Record<string, Schema>
      required: string[]
      additionalProperties: false
    }

const string: Schema = { type: 'string' }
const line: Schema = { type: 'integer', minimum: 1 }
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties)
): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const array = (items: Schema, minItems: number, maxItems: number): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems
})

const source = object({ path: string, startLine: line, endLine: line })
const state = { id: string, label: string }
const transition = { id: string, from: string, to: string, trigger: string }

export const graphSchema = object({
  initialStateId: string,
  states: array(object({ ...state, sources: array(source, 1, 4) }), 4, 4),
  transitions: array(object({ ...transition, sources: array(source, 1, 4) }), 3, 3)
})

export const proposalSchema = object(
  {
    kind: { type: 'string', enum: ['edit', 'clarification'] },
    summary: string,
    replaceTransitionId: string,
    addStates: array(object(state), 0, 4),
    addTransitions: array(object(transition), 1, 8),
    question: string
  },
  ['kind']
)

function matches(value: unknown, schema: Schema): boolean {
  switch (schema.type) {
    case 'string':
      return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= 500 &&
        (!schema.enum || schema.enum.includes(value))
      )
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= schema.minimum
    case 'array':
      return (
        Array.isArray(value) &&
        value.length >= schema.minItems &&
        value.length <= schema.maxItems &&
        Array.from(value).every((item) => matches(item, schema.items))
      )
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const fields = value as Record<string, unknown>
      return (
        schema.required.every((key) => Object.hasOwn(fields, key)) &&
        Object.entries(fields).every(
          ([key, entry]) =>
            Object.hasOwn(schema.properties, key) && matches(entry, schema.properties[key])
        )
      )
    }
  }
}

function validTransitions(states: GraphState[], transitions: GraphTransition[]): boolean {
  const stateIds = new Set(states.map(({ id }) => id))
  const transitionIds = new Set(transitions.map(({ id }) => id))
  return (
    stateIds.size === states.length &&
    transitionIds.size === transitions.length &&
    transitions.every(
      ({ id, from, to }) => id === `${from}->${to}` && stateIds.has(from) && stateIds.has(to)
    )
  )
}

export function validateGraph(value: unknown, files: FixtureSource[]): CurrentGraph {
  const error = new Error('CurrentGraph failed server validation.')
  if (!matches(value, graphSchema)) throw error
  const graph = value as CurrentGraph
  const fixtureStateIds = ['queued', 'running', 'succeeded', 'failed']
  const fixtureTransitionIds = ['queued->running', 'running->succeeded', 'running->failed']
  const lineCounts = new Map(
    files.map(({ path, text }) => [path, text.trimEnd().split(/\r?\n/).length])
  )

  if (
    graph.initialStateId !== 'queued' ||
    !graph.states.every(({ id }) => fixtureStateIds.includes(id)) ||
    !graph.transitions.every(({ id }) => fixtureTransitionIds.includes(id)) ||
    !validTransitions(graph.states, graph.transitions) ||
    ![...graph.states, ...graph.transitions].every(({ sources }) =>
      sources.every(
        ({ path, startLine, endLine }) =>
          startLine <= endLine && endLine <= (lineCounts.get(path) ?? 0)
      )
    )
  ) {
    throw error
  }
  return graph
}

export function validateProposal(value: unknown, graph: CurrentGraph): ProposalResult {
  const error = new Error('Gemini proposal failed server validation.')
  if (!matches(value, proposalSchema)) throw error
  const result = value as ProposalResult

  if (result.kind === 'clarification') {
    if (!Object.hasOwn(result, 'question') || Object.keys(result).length !== 2) throw error
    return result
  }

  if (
    Object.keys(result).length !== 5 ||
    !['summary', 'replaceTransitionId', 'addStates', 'addTransitions'].every((key) =>
      Object.hasOwn(result, key)
    )
  ) {
    throw error
  }
  const target = graph.transitions.find(({ id }) => id === result.replaceTransitionId)
  const states = [...graph.states, ...result.addStates]
  const retained = graph.transitions.filter(({ id }) => id !== result.replaceTransitionId)
  if (
    !target ||
    !result.addStates.every(({ id }) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) ||
    !validTransitions(states, [...retained, ...result.addTransitions])
  ) {
    throw error
  }

  const reachable = new Set([target.from])
  for (let pass = 1; pass < states.length; pass++) {
    for (const { from, to } of result.addTransitions) {
      if (reachable.has(from)) reachable.add(to)
    }
  }
  if (
    !reachable.has(target.to) ||
    !result.addStates.every(({ id }) => reachable.has(id)) ||
    !result.addTransitions.every(({ from }) => reachable.has(from))
  ) {
    throw error
  }
  return result
}
