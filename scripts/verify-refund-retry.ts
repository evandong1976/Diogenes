// Verify a hand-supplied candidate commit against the frozen refund retry approval.
// node --experimental-transform-types scripts/verify-refund-retry.ts <candidate> [packet.json] [sha256]
// Bend comes from $DIOGENES_BEND or PATH; `bend --verdict` reads the BendTT kernel from $BENDTT.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pinnedBend, verifyRefundRetry } from '../src/main/verification/refundRetry.ts'

const repoDir = fileURLToPath(new URL('..', import.meta.url))
const approval = new URL('../fixtures/refund-retry-approval/', import.meta.url)
const [candidate, packet = fileURLToPath(new URL('packet.json', approval)), digest] =
  process.argv.slice(2)
if (!candidate) {
  console.error('usage: verify-refund-retry.ts <candidate-commit> [packet.json] [sha256]')
  process.exit(2)
}
const report = verifyRefundRetry({
  repoDir,
  packetPath: packet,
  trustedDigest: digest ?? readFileSync(new URL('packet.sha256', approval), 'utf8'),
  candidate,
  bend: pinnedBend()
})
console.log(JSON.stringify(report, null, 2))
process.exit(report.valid && report.overall === 'pass' ? 0 : 1)
