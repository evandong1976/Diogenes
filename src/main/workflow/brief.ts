/** Markdown the coding run reads, and the correction section added for a bounded retry. */
import { editableScope } from '../../shared/workflow'
import type {
  ApprovedChange,
  CatalogApprovedChange,
  CorrectionRequest,
  RetryApprovedChange
} from '../../shared/workflow'

const list = (items: string[]): string => items.map((i) => `- ${i}`).join('\n')

export function codingBrief(packet: ApprovedChange, correction?: CorrectionRequest): string {
  const sections = packet.kind === 'catalog' ? catalogSections(packet) : retrySections(packet)
  if (correction) sections.push(correctionSection(correction))
  return sections.join('\n\n')
}

/** A steer: the developer's direction for the same change, sent as a follow-up turn. */
export function steerBrief(packet: ApprovedChange, message: string): string {
  return [
    `Follow-up from the developer about your change to ${packet.repository.fullName}:`,
    message,
    '',
    `The goal is the same. The code must still:\n${list(packet.requiredChanges.map(task))}`,
    `Edit only: ${editableScope(packet).join(', ')}`
  ].join('\n')
}

/** A correction sent as a follow-up turn in the same workspace. */
export function correctionBrief(packet: ApprovedChange, correction: CorrectionRequest): string {
  return steerBrief(packet, correctionSection(correction))
}

/**
 * The approved design as an ordinary task in the repository's own code. The packet's graph
 * wording ("A calls B is connected") is turned into what the code must do; Diogenes' catalog,
 * patch and IDs stay out of it, so the agent edits the application, not the design tool.
 */
function catalogSections(packet: CatalogApprovedChange): string[] {
  const scope = packet.scope.map((p) => `\`${p}\``).join(', ')
  return [
    `# Change ${packet.repository.fullName}: ${task(packet.requiredChanges[0] ?? packet.targetComponentId)}`,
    `Make this change in the repository's source code, starting from commit ${packet.baseCommit}. Work only in ${scope}. This is a normal code change in the application: edit its files so the behavior below is true. Do not create or edit design files, catalogs or graph data.`,
    `## What the code must do\n${list(packet.requiredChanges.map(task))}`,
    `## Keep working\n${list(packet.preserved.map(keep))}`,
    `## Up to you\n${list(packet.openChoices)}`,
    `## How your change is checked\nYour turn finishing does not accept the change. When you are done, the repository is type checked and your code is read again to confirm each point above. Accepted only if all of these pass:\n${list(
      packet.obligations.map((o) => `\`${o.id}\`: ${o.scope}`)
    )}`
  ]
}

/** "A calls B is connected" → "A calls B"; "… is no longer connected" → "A no longer calls B". */
function task(line: string): string {
  const gone = /^(.+?) (\S+) (.+) is no longer connected$/.exec(line)
  if (gone) return `${gone[1]} no longer ${gone[2]} ${gone[3]}`
  return line.replace(/ is connected$/, '')
}

const keep = (line: string): string => line.replace(/ stays connected$/, ' (keep this)')

function retrySections(packet: RetryApprovedChange): string[] {
  const { bindings: b } = packet
  return [
    `# Implement approved change to ${packet.targetComponentId}`,
    `Repository ${packet.repository.fullName} at base commit ${packet.baseCommit}. Edit only files under \`${b.root}/\`.`,
    `## Required changes\n${list(packet.requiredChanges)}`,
    `## Must stay the same\n${list(packet.preserved)}`,
    `## Your choice\n${list(packet.openChoices)}`,
    [
      '## Bindings',
      `- Reducer: \`${b.root}/${b.reducer.file}\` export \`${b.reducer.export}\``,
      `- Caller: \`${b.root}/${b.caller.file}\` export \`${b.caller.export}\``,
      `- Proof: \`${b.root}/${b.proof.file}\` must prove \`LAWS.bend#conforms\` (the law is generated from the approved graph)`,
      `- \`${b.root}/domain.bend\` must declare exactly the approved states`
    ].join('\n'),
    `## Checked locally after you finish\nYour run completing does not accept the change. These checks do.\n${list(
      packet.obligations.map((o) => `\`${o.id}\`: ${o.scope}`)
    )}`,
    `## Approved transitions\n\`\`\`json\n${JSON.stringify(packet.patch.operations, null, 2)}\n\`\`\``
  ]
}

function correctionSection(correction: CorrectionRequest): string {
  return [
    `## Correction requested: fix your previous change`,
    `Your last change (${correction.previousCandidateId.slice(0, 12)}) did not pass these checks: ${correction.obligationIds.join(', ')}. Keep what works and fix only this.`,
    correction.instructions,
    ...correction.mismatches.map(
      (m) =>
        `### ${m.obligationId}${m.transitionIds.length ? ` (transitions ${m.transitionIds.join(', ')})` : ''}\n\`\`\`\n${m.lines.join('\n')}\n\`\`\``
    )
  ].join('\n\n')
}
