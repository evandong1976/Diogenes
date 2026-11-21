/** Markdown the coding run reads, and the correction section added for a bounded retry. */
import type { ApprovedChange, CorrectionRequest } from '../../shared/workflow'

export function codingBrief(packet: ApprovedChange, correction?: CorrectionRequest): string {
  const { bindings: b } = packet
  const list = (items: string[]): string => items.map((i) => `- ${i}`).join('\n')
  const sections = [
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
  if (correction)
    sections.push(
      [
        `## Correction requested for candidate ${correction.previousCandidateId}`,
        `The approval is unchanged. Fix only what failed: ${correction.obligationIds.join(', ')}.`,
        correction.instructions,
        ...correction.mismatches.map(
          (m) =>
            `### ${m.obligationId}${m.transitionIds.length ? ` (transitions ${m.transitionIds.join(', ')})` : ''}\n\`\`\`\n${m.lines.join('\n')}\n\`\`\``
        )
      ].join('\n\n')
    )
  return sections.join('\n\n')
}
