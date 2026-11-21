import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { WorkflowService } from './service.ts'
import { refundRetryVerifier } from './verifiers.ts'
import {
  workflowChannels,
  type CodingGateway,
  type DecisionOption,
  type DesignThreadSink,
  type ObligationId
} from '../../shared/workflow'

/** Until the coding gateway is wired in, handoffs fail loudly instead of pretending to run. */
const unavailableGateway: CodingGateway = new Proxy({} as CodingGateway, {
  get: () => async () => {
    throw new Error('The coding gateway is not connected in this build.')
  }
})

/** Until the design thread service is wired in, results stay queryable through getProject. */
const queryOnlyThreads: DesignThreadSink = { post: async () => undefined }

export function registerWorkflowIpc(
  deps: { gateway?: CodingGateway; threads?: DesignThreadSink } = {}
): WorkflowService {
  const service = new WorkflowService({
    storeDir: join(app.getPath('userData'), 'workflow'),
    // A local clone that contains the approved base commit.
    repoFor: (projectId) => {
      const dir = process.env.DIOGENES_WORKFLOW_REPO
      if (!dir) throw new Error(`No local repository is configured for project ${projectId}.`)
      return dir
    },
    gateway: deps.gateway ?? unavailableGateway,
    threads: deps.threads ?? queryOnlyThreads,
    verifiers: [refundRetryVerifier()]
  })
  const id = (value: unknown): string => {
    if (typeof value !== 'string' || !value) throw new Error('Expected an ID.')
    return value
  }
  const object = <T>(value: unknown): T => {
    if (!value || typeof value !== 'object') throw new Error('Expected an object.')
    return value as T
  }
  const c = workflowChannels
  ipcMain.handle(c.preview, (_e, r) => service.preview(object(r)))
  ipcMain.handle(c.approve, (_e, r) => service.approve(object(r)))
  ipcMain.handle(c.startHandoff, (_e, a) => service.startHandoff(id(a)))
  ipcMain.handle(c.refresh, (_e, h) => service.refresh(id(h)))
  ipcMain.handle(c.steer, (_e, h, m) => service.steer(id(h), id(m)))
  ipcMain.handle(c.cancel, (_e, h) => service.cancel(id(h)))
  ipcMain.handle(c.requestCorrection, (_e, h, r) => {
    const req = object<{ obligationIds: ObligationId[]; instructions: string }>(r)
    if (!Array.isArray(req.obligationIds) || typeof req.instructions !== 'string')
      throw new Error('Expected obligationIds and instructions.')
    return service.requestCorrection(id(h), req)
  })
  ipcMain.handle(c.resolveDecision, (_e, h, o) =>
    service.resolveDecision(id(h), id(o) as DecisionOption)
  )
  ipcMain.handle(c.getHandoff, (_e, h) => service.getHandoff(id(h)))
  ipcMain.handle(c.getProject, (_e, p) => service.getProject(id(p)))
  return service
}
