/**
 * Local verifiers, keyed by the verifier ID frozen in the approval. A packet naming a verifier
 * that is not registered gets an all-unknown verdict marked `unsupported`, never a pass.
 */
import { retryEventKey } from '../catalog/editing.ts'
import {
  VERIFIER_ID,
  pinnedBend,
  verifyRefundRetry,
  type VerificationReport
} from '../verification/refundRetry.ts'
import type { RetryBehavior } from '../../shared/catalog'
import type {
  ApprovedChange,
  Mismatch,
  ObligationVerdict,
  Outcome,
  UnknownReason,
  Verdict
} from '../../shared/workflow'

export interface LocalVerifier {
  id: string
  verify(input: {
    repoDir: string
    packetPath: string
    trustedDigest: string
    candidate: string
  }): VerificationReport
}

export function refundRetryVerifier(bend: string = pinnedBend()): LocalVerifier {
  return { id: VERIFIER_ID, verify: (input) => verifyRefundRetry({ ...input, bend }) }
}

export type VerdictContext = Pick<
  Verdict,
  'approvalId' | 'candidateId' | 'handoffId' | 'runId' | 'remoteClaim' | 'verifiedAt'
>

/** Missing tools are `unavailable`; a tool that ran without reaching a verdict is `inconclusive`. */
const UNAVAILABLE = /infrastructure|reports nothing|the approval pins|not found in \$PATH|ENOENT/i

export function toVerdict(
  packet: ApprovedChange,
  report: VerificationReport,
  ctx: VerdictContext
): Verdict {
  const verifier = packet.toolchain.verifier
  if (!report.valid)
    return {
      ...ctx,
      verifier,
      overall: 'unknown',
      invalid: report.reason,
      obligations: packet.obligations.map((o) => ({
        id: o.id,
        outcome: 'unknown',
        unknownReason: 'inconclusive',
        scope: o.scope,
        tool: verifier,
        target: packet.bindings.root,
        evidence: { ran: false },
        diagnostic: report.reason
      }))
    }
  if (report.packetDigest !== ctx.approvalId || report.candidateSha !== ctx.candidateId)
    throw new Error('Verifier report does not name the expected approval and candidate')
  const obligations = report.obligations.map((r): ObligationVerdict => {
    const unknownReason: UnknownReason | undefined =
      r.outcome !== 'unknown'
        ? undefined
        : !r.evidence.ran || UNAVAILABLE.test(r.diagnostic ?? '')
          ? 'unavailable'
          : 'inconclusive'
    return {
      id: r.id,
      outcome: r.outcome,
      ...(unknownReason && { unknownReason }),
      scope: packet.obligations.find((o) => o.id === r.id)?.scope ?? '',
      tool: r.tool,
      target: r.target,
      evidence: r.evidence,
      ...(r.diagnostic !== undefined && { diagnostic: r.diagnostic })
    }
  })
  return { ...ctx, verifier, overall: report.overall, obligations }
}

export function unsupportedVerdict(packet: ApprovedChange, ctx: VerdictContext): Verdict {
  const verifier = packet.toolchain.verifier
  return {
    ...ctx,
    verifier,
    overall: 'unknown',
    obligations: packet.obligations.map((o) => ({
      id: o.id,
      outcome: 'unknown' as Outcome,
      unknownReason: 'unsupported',
      scope: o.scope,
      tool: 'none',
      target: packet.bindings.root,
      evidence: { ran: false },
      diagnostic: `No local verifier is registered for ${verifier}`
    }))
  }
}

/** Failing obligations, each tied to the approved transitions its diagnostic names. */
export function mismatchesOf(verdict: Verdict, behavior: RetryBehavior): Mismatch[] {
  const rows = new Map(
    behavior.transitions.map((t) => [`${t.from}/${retryEventKey(t.event)}`, t.id])
  )
  return verdict.obligations
    .filter((o) => o.outcome === 'fail')
    .map((o) => {
      const lines = (o.diagnostic ?? '').split('\n').filter(Boolean)
      const ids = new Set<string>()
      for (const line of lines)
        for (const [, pair] of line.matchAll(/\b(\w+\/(?:Start|(?:Succeeded|Failed)\(\d\)))/g)) {
          const id = rows.get(pair)
          if (id) ids.add(id)
        }
      return { obligationId: o.id, transitionIds: [...ids], lines }
    })
}
