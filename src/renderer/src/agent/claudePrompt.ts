import type { Proposal } from '../../../shared/design'

const MARK = { added: '+', updated: '~', removed: '−' } as const

/**
 * The brief a Claude Code agent gets for an approved proposal: what to build, what must stay
 * true, and how to check it. Plain Markdown; it never starts with "-" so the CLI reads it as the
 * prompt rather than a flag.
 */
export function claudePrompt(proposal: Proposal): string {
  const { plan, preview } = proposal
  const list = (items: string[] | undefined): string =>
    items?.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)'
  const sections = [
    `# Implement this approved change (from Diogenes)`,
    `${proposal.summary}`,
    plan?.conversationSummary && `## Context\n${plan.conversationSummary}`,
    plan && `## Intended behavior\n${plan.behavior}`,
    plan && `## Steps\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    (preview.components.length > 0 || preview.connections.length > 0) &&
      `## Affected components\n${[
        ...preview.components.map((c) => `- ${MARK[c.change]} ${c.name}`),
        ...preview.connections.map(
          (c) => `- ${c.change === 'added' ? '+' : '−'} ${c.from} → ${c.to} (${c.kind})`
        )
      ].join('\n')}`,
    plan?.files?.length && `## Files to touch beyond those components\n${list(plan.files)}`,
    plan && `## Must stay true\n${list(plan.preserved)}`,
    plan?.implementationChoices?.length && `## Left to you\n${list(plan.implementationChoices)}`,
    plan && `## Acceptance checks\n${list(plan.acceptance)}`,
    proposal.evidence.length > 0 &&
      `## Where this came from\n${proposal.evidence
        .slice(0, 20)
        .map((e) => `- ${e.path}:${e.startLine + 1}–${Math.max(e.startLine + 1, e.endLine)}`)
        .join('\n')}`,
    `## How to work\nWork in this repository. Keep the change to what's described above, run the acceptance checks and the project's tests, then summarize what you changed and how you checked it. Don't push or open a pull request unless asked.`
  ]
  return sections.filter(Boolean).join('\n\n')
}
