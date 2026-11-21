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

/** Plain shell in the managed workspace; the run has no other tools from Diogenes. */
const WORKSPACE = `## Working in the workspace
Use ordinary shell commands in this workspace:
- look around: \`ls\`, \`cat\`, \`sed -n '1,80p' <file>\`, \`grep -rn '<name>' <dir>\`
- see your change: \`git status\`, \`git diff\`
- run focused checks the repository already has (for example \`npx tsc --noEmit\` or the test file next to what you changed). Dependencies may not be installed; do not add new tooling to make a check run.
Do not connect to, migrate or seed any real database or external service. Change code only.`

function catalogSections(packet: CatalogApprovedChange): string[] {
  const { plan } = packet
  const goal = plan?.summary ?? task(packet.requiredChanges[0] ?? 'Implement the approved design')
  return [
    `# ${goal}`,
    `Make the change in ${packet.repository.fullName} at commit ${packet.baseCommit}. Edit the repository code only in ${packet.scope.map((p) => `\`${p}\``).join(', ')}.`,
    ...(plan
      ? [
          `## Intended behavior\n${plan.summary}\n\n${plan.behavior}`,
          `## Steps\n${plan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`,
          ...(plan.files?.length
            ? [`Files the plan names: ${plan.files.map((f) => `\`${f}\``).join(', ')}.`]
            : [])
        ]
      : []),
    `## What the code must do\n${list(packet.requiredChanges.map(task))}`,
    `## Must stay the same\n${list([...(plan?.preserved ?? []), ...packet.preserved.map(keep)])}`,
    `## Your choice\n${list(packet.openChoices)}`,
    ...(plan?.evidence.length ? [evidenceSection(packet.baseCommit, plan.evidence)] : []),
    ...(plan?.acceptance.length
      ? [
          `## Acceptance checks from the plan (not verified by Diogenes)\nRun these where you can and say what you saw. They guide the work; they do not accept it, and Diogenes reports nothing about them as passed.\n${list(plan.acceptance)}`
        ]
      : []),
    WORKSPACE,
    `## How your change is checked\nYour run completing does not accept the change. These checks do, on the exact files you export: the repository is type checked and re-indexed, and each connection below is looked up in the re-indexed code.\n${list(
      packet.obligations.map((o) => `\`${o.id}\`: ${o.scope}`)
    )}`,
    ...(packet.unobservable.length
      ? [
          `## Required but not observable locally\nDo these; the re-index cannot see them, so they are reported \`unknown\`, never passed.\n${list(packet.unobservable)}`
        ]
      : [])
  ]
}

function evidenceSection(
  baseCommit: string,
  evidence: NonNullable<CatalogApprovedChange['plan']>['evidence']
): string {
  return [
    `## Code evidence at ${baseCommit.slice(0, 7)}`,
    ...evidence.map(
      (e) =>
        `### \`${e.path}:${e.startLine + 1}–${Math.max(e.startLine + 1, e.endLine)}\`\n\`\`\`\n${e.excerpt}\n\`\`\``
    )
  ].join('\n\n')
}

/** Convert the verifier's edge descriptions into instructions about the code. */
function task(line: string): string {
  const remains = line.replace(/ is connected$/, '')
  const removed = remains.replace(/ is no longer connected$/, '')
  return removed === remains ? remains : `Remove the connection where ${removed}.`
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
    WORKSPACE,
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
