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

/** A steer: the developer's direction for the same approval, sent as a follow-up turn. */
export function steerBrief(packet: ApprovedChange, message: string): string {
  return [
    `Direction from the developer for the approved change to ${packet.targetComponentId}:`,
    message,
    '',
    `The approval is unchanged. Still required:\n${list(packet.requiredChanges)}`,
    `Edit only: ${editableScope(packet).join(', ')}`
  ].join('\n')
}

/** A correction sent as a follow-up turn in the same workspace. */
export function correctionBrief(packet: ApprovedChange, correction: CorrectionRequest): string {
  return steerBrief(packet, correctionSection(correction))
}

function catalogSections(packet: CatalogApprovedChange): string[] {
  return [
    `# Implement approved change around ${packet.targetComponentId}`,
    `Repository ${packet.repository.fullName} at base commit ${packet.baseCommit}. Edit only: ${packet.scope.map((p) => `\`${p}\``).join(', ')}.`,
    `## Required changes\n${list(packet.requiredChanges)}`,
    `## Must stay the same\n${list(packet.preserved)}`,
    `## Your choice\n${list(packet.openChoices)}`,
    `## Checked locally after you finish\nYour run completing does not accept the change. These checks do, on the exact files you export: the repository is type checked and re-indexed, and each connection below is looked up in the re-indexed code.\n${list(
      packet.obligations.map((o) => `\`${o.id}\`: ${o.scope}`)
    )}`,
    `## Connections\n${list(packet.connections.map((c) => `${c.expect === 'present' ? 'must exist' : 'must not exist'}: ${c.kind} ${c.from} -> ${c.to}`))}`,
    `## Approved catalog patch\n\`\`\`json\n${JSON.stringify(packet.patch.operations, null, 2)}\n\`\`\``
  ]
}

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
    `## Correction requested for candidate ${correction.previousCandidateId}`,
    `The approval is unchanged. Fix only what failed: ${correction.obligationIds.join(', ')}.`,
    correction.instructions,
    ...correction.mismatches.map(
      (m) =>
        `### ${m.obligationId}${m.transitionIds.length ? ` (transitions ${m.transitionIds.join(', ')})` : ''}\n\`\`\`\n${m.lines.join('\n')}\n\`\`\``
    )
  ].join('\n\n')
}
