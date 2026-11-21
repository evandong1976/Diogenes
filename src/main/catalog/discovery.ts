// Derives the observed catalog (revision 0) from an indexed SoftwareGraph and the commit-pinned
// source snapshot. Discovery is deterministic and evidence-only: every node and edge cites the
// source it came from, and anything that cannot be established is left undefined or `unresolved`.
//
// Adapters, all narrow and anchored to explicit evidence:
//   - Electron IPC: `ipcMain.handle|handleOnce` and `ipcRenderer.invoke` on bindings imported from
//     'electron'. Channels are string literals, or `X.y` where the index resolves `y` to a property
//     of an `as const` object literal whose value is a string literal.
//   - HTTP: `app.<method>('/path', …)` where `app` was created by `express()` / `express.Router()`
//     / `Router()` imported from 'express' in the same file.
//   - package.json: Module per manifest, Workload for `bin` entries and for `main` of Electron apps,
//     `depends_on` between modules in the snapshot.
//   - `*.schema.json` with a json-schema.org `$schema`: Data Contract.
//   - Block-style Compose services with a known datastore/broker image: Resource.
// Computed IPC/HTTP addresses become `unresolved` Operations at their site rather than guesses.

import type * as TS from 'typescript'
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogEdge,
  type CatalogEdgeKind,
  type CatalogGraph,
  type CatalogNode,
  type CatalogProtocol,
  type CatalogSource
} from '../../shared/catalog'
import type { GraphEdge, GraphNode, SoftwareGraph, SourceSpan } from '../../shared/indexing'
import { loadTypescript, type TsModule } from '../indexing/scip'
import {
  composeResources,
  isComposePath,
  isJsonSchemaPath,
  jsonKeySpan,
  jsonSchemaContract,
  parsePackage,
  type PackageManifest
} from './discoveryManifests'

export type ReadSource = (path: string) => Promise<string | null>

const SOURCE_EXT = /\.(m|c)?[jt]sx?$/
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'])
const IPC_HANDLE = new Set(['handle', 'handleOnce'])

type Address = { value: string; sources: CatalogSource[] } | null

type Registration = {
  protocol: CatalogProtocol
  /** Operation identity scope: module root for IPC, `<file>#<app>` for HTTP. */
  scope: string
  address: Address
  /** Text of a computed address, for naming unresolved operations. */
  text: string
  site: SourceSpan
  role: 'provide' | 'invoke'
  handlerId?: string
  handlerSource?: CatalogSource
  callerId?: string
  evidenceId?: string
  routerRelative?: boolean
}

export async function deriveCatalog(
  graph: SoftwareGraph,
  readSource: ReadSource
): Promise<CatalogGraph> {
  const ts = loadTypescript()
  const files = [...graph.files].sort((a, b) => cmp(a.path, b.path))
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]))
  const edgesAtSite = new Map<string, GraphEdge[]>()
  for (const e of [...graph.edges].sort((a, b) => cmp(a.id, b.id))) {
    for (const s of e.sites) push(edgesAtSite, spanKey(s), e)
  }
  const texts = new Map<string, string | null>()
  const read = async (path: string): Promise<string | null> => {
    if (!texts.has(path)) texts.set(path, await readSource(path).catch(() => null))
    return texts.get(path)!
  }
  const parsed = new Map<string, TS.SourceFile | null>()
  const parse = async (path: string): Promise<TS.SourceFile | null> => {
    if (!parsed.has(path)) {
      const text = await read(path)
      parsed.set(path, text === null ? null : createSource(ts, path, text))
    }
    return parsed.get(path)!
  }

  const out = new CatalogBuilder()

  // ---- Manifests ---------------------------------------------------------------------------
  const packages: PackageManifest[] = []
  for (const f of files) {
    if (f.status === 'rejected') continue
    if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
      const text = await read(f.path)
      const pkg = text === null ? null : parsePackage(f.path, text)
      if (pkg) packages.push(pkg)
    } else if (isJsonSchemaPath(f.path)) {
      const text = await read(f.path)
      const node = text === null ? null : jsonSchemaContract(f.path, text)
      if (node) out.node(node, f.path)
    } else if (isComposePath(f.path)) {
      const text = await read(f.path)
      for (const node of text === null ? [] : composeResources(f.path, text)) out.node(node, f.path)
    }
  }
  const roots = packages.map((p) => p.root)
  /** Nearest package root containing `path`, excluding `self` (for nesting packages). */
  const rootOf = (path: string, self?: string): string | undefined => {
    let best: string | undefined
    for (const r of roots) {
      if (r === self || (r !== '.' && !path.startsWith(`${r}/`))) continue
      if (best === undefined || best === '.' || (r !== '.' && r.length > best.length)) best = r
    }
    return best
  }
  const moduleOf = (path: string): string | undefined => {
    const r = rootOf(path)
    return r === undefined ? undefined : moduleId(r)
  }
  out.moduleOf = moduleOf
  const byName = new Map(packages.filter((p) => p.name).map((p) => [p.name!, p]))
  for (const pkg of packages) {
    const id = moduleId(pkg.root)
    out.nodes.set(id, {
      id,
      kind: 'module',
      name: pkg.name ?? pkg.root,
      resolution: 'declared',
      properties: { ecosystem: 'npm', packageName: pkg.name, root: pkg.root },
      ports: [],
      sources: [
        { path: pkg.path, field: 'packageName', span: jsonKeySpan(pkg.path, pkg.text, 'name') }
      ]
    })
    const parent = pkg.root === '.' ? undefined : rootOf(pkg.root, pkg.root)
    if (parent !== undefined) out.edge('contains', moduleId(parent), id, [])
    const workloads: [string, 'process' | 'cli', string, string][] = []
    if (pkg.electron && pkg.main) workloads.push(['main', 'process', pkg.main, 'main'])
    for (const [name, entry] of Object.entries(pkg.bin).sort(([a], [b]) => cmp(a, b)))
      workloads.push([`bin:${name}`, 'cli', entry, 'bin'])
    for (const [key, role, entryPoint, field] of workloads) {
      const wid = `workload:npm:${pkg.root}:${key}`
      out.nodes.set(wid, {
        id: wid,
        kind: 'workload',
        name: key === 'main' ? `${pkg.name ?? pkg.root} main process` : key.slice(4),
        resolution: 'declared',
        properties: { role, entryPoint },
        ports: [],
        sources: [
          { path: pkg.path, field: 'entryPoint', span: jsonKeySpan(pkg.path, pkg.text, field) }
        ]
      })
      out.edge('contains', id, wid, [])
    }
    for (const dep of pkg.dependencies) {
      const target = byName.get(dep)
      if (!target || target === pkg) continue
      out.edge('depends_on', id, moduleId(target.root), [
        { path: pkg.path, field: 'dependencies', span: jsonKeySpan(pkg.path, pkg.text, dep) }
      ])
    }
  }

  // ---- Source registrations ------------------------------------------------------------------
  const regs: Registration[] = []
  for (const f of files) {
    if (f.status !== 'analyzed' || !SOURCE_EXT.test(f.path)) continue
    const sf = await parse(f.path)
    if (!sf) continue
    const scope = moduleOf(f.path)?.slice('module:npm:'.length) ?? '.'
    const ctx: ScanContext = {
      ts,
      sf,
      path: f.path,
      scope,
      edgesAtSite,
      resolveConst: (site) => resolveConstString(ts, site, edgesAtSite, nodesById, parse)
    }
    regs.push(...(await scanFile(ctx)))
  }

  // ---- Operations and call edges -------------------------------------------------------------
  const literalOps = new Map<string, Registration[]>()
  for (const r of regs) {
    if (!r.address) {
      const id = `operation:${r.protocol}:${r.scope}:?${r.site.path}:${r.site.start.line}:${r.site.start.character}`
      out.node(
        operationNode(
          id,
          `${r.role === 'provide' ? 'handler' : 'call'} for ${r.text}`,
          r.protocol,
          'unresolved',
          undefined,
          [regSource(r)]
        ),
        r.site.path
      )
      if (r.role === 'invoke') out.call(r, id, nodesById)
      continue
    }
    push(literalOps, `operation:${r.protocol}:${r.scope}:${r.address.value}`, r)
  }
  for (const [id, rs] of [...literalOps].sort(([a], [b]) => cmp(a, b))) {
    const provides = rs.filter((r) => r.role === 'provide')
    const handlers = new Set(provides.map((r) => r.handlerId))
    const handlerId = handlers.size === 1 ? [...handlers][0] : undefined
    const sources: CatalogSource[] = []
    for (const r of provides) {
      sources.push(regSource(r), ...r.address!.sources)
      if (r.handlerSource) sources.push(r.handlerSource)
    }
    if (!provides.length) for (const r of rs) sources.push(...r.address!.sources)
    const first = rs[0]
    const resolution = !provides.length
      ? 'unresolved'
      : provides.every((r) => r.routerRelative)
        ? 'declared'
        : 'bound'
    out.node(
      operationNode(
        id,
        first.address!.value,
        first.protocol,
        resolution,
        first.address!.value,
        sources,
        handlerId
      ),
      (provides[0] ?? first).site.path
    )
    for (const r of rs) if (r.role === 'invoke') out.call(r, id, nodesById)
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    repository: { ...graph.repository },
    commit: { ...graph.commit },
    revision: 0,
    nodes: [...out.nodes.values()]
      .map((n) => ({ ...n, sources: dedupeSources(n.sources) }) as CatalogNode)
      .sort((a, b) => cmp(a.id, b.id)),
    edges: [...out.edges.values()]
      .map((e) => ({ ...e, sources: dedupeSources(e.sources) }))
      .sort((a, b) => cmp(a.id, b.id))
  }
}

// ---- Catalog assembly ----------------------------------------------------------------------------

class CatalogBuilder {
  readonly nodes = new Map<string, CatalogNode>()
  readonly edges = new Map<string, CatalogEdge>()
  moduleOf: (path: string) => string | undefined = () => undefined

  /** Adds a node and its primary containment by the nearest package. */
  node(node: CatalogNode, path: string): void {
    const existing = this.nodes.get(node.id)
    if (existing) {
      existing.sources.push(...node.sources)
      return
    }
    this.nodes.set(node.id, node)
    const owner = this.moduleOf(path)
    if (owner && owner !== node.id) this.edge('contains', owner, node.id, [])
  }

  edge(
    kind: CatalogEdgeKind,
    from: string,
    to: string,
    sources: CatalogSource[],
    ports?: [string, string]
  ): void {
    const id = `${kind}:${from}->${to}`
    const existing = this.edges.get(id)
    if (existing) {
      existing.sources.push(...sources)
      return
    }
    this.edges.set(id, {
      id,
      kind,
      from: ports ? { nodeId: from, portId: ports[0] } : { nodeId: from },
      to: ports ? { nodeId: to, portId: ports[1] } : { nodeId: to },
      sources: [...sources]
    })
  }

  /** Invocations hang off a Generic node for the indexed caller, kept for source drill-down. */
  call(r: Registration, operationId: string, nodesById: Map<string, GraphNode>): void {
    const graphId = r.callerId ?? `file:${r.site.path}`
    const caller = nodesById.get(graphId)
    const id = `generic:${graphId}`
    const port = `out:${r.protocol}`
    const node = this.nodes.get(id)
    if (!node) {
      this.node(
        {
          id,
          kind: 'generic',
          name: caller?.name ?? r.site.path,
          resolution: 'bound',
          properties: { description: `Indexed source ${graphId}` },
          ports: [{ id: port, direction: 'out', protocol: r.protocol }],
          sources: [
            { path: r.site.path, span: caller?.extent ?? caller?.span, evidenceId: graphId }
          ]
        },
        r.site.path
      )
    } else if (!node.ports.some((p) => p.id === port)) {
      node.ports.push({ id: port, direction: 'out', protocol: r.protocol })
      node.ports.sort((a, b) => cmp(a.id, b.id))
    }
    this.edge('calls', id, operationId, [{ ...regSource(r), field: 'invocation' }], [port, 'in'])
  }
}

function operationNode(
  id: string,
  name: string,
  protocol: CatalogProtocol,
  resolution: CatalogNode['resolution'],
  address: string | undefined,
  sources: CatalogSource[],
  handlerId?: string
): CatalogNode {
  return {
    id,
    kind: 'operation',
    name,
    resolution,
    properties: { protocol, address, handlerId },
    ports: [{ id: 'in', direction: 'in', protocol }],
    sources
  }
}

function regSource(r: Registration): CatalogSource {
  return {
    path: r.site.path,
    span: r.site,
    evidenceId: r.evidenceId,
    field: r.role === 'provide' ? 'registration' : 'invocation'
  }
}

// ---- Per-file scan -----------------------------------------------------------------------------

type ScanContext = {
  ts: TsModule
  sf: TS.SourceFile
  path: string
  scope: string
  edgesAtSite: Map<string, GraphEdge[]>
  resolveConst: (site: SourceSpan) => Promise<Address>
}

type Bindings = {
  /** Local name → electron export (`ipcMain` / `ipcRenderer`). */
  electronNamed: Map<string, string>
  /** Local names bound to the whole 'electron' module. */
  electronNs: Set<string>
  /** Local names for the express default export / namespace. */
  expressNs: Set<string>
  /** Local names bound to `Router` from 'express'. */
  expressRouter: Set<string>
}

function collectBindings(ts: TsModule, sf: TS.SourceFile): Bindings {
  const b: Bindings = {
    electronNamed: new Map(),
    electronNs: new Set(),
    expressNs: new Set(),
    expressRouter: new Set()
  }
  const bindModule = (
    spec: string,
    kind: 'ns' | 'named',
    local: string,
    imported = local
  ): void => {
    if (spec === 'electron') {
      if (kind === 'ns') b.electronNs.add(local)
      else if (imported === 'ipcMain' || imported === 'ipcRenderer')
        b.electronNamed.set(local, imported)
    } else if (spec === 'express') {
      if (kind === 'ns') b.expressNs.add(local)
      else if (imported === 'Router') b.expressRouter.add(local)
    }
  }
  const requireOf = (e: TS.Expression | undefined): string | undefined =>
    e &&
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'require' &&
    e.arguments.length === 1 &&
    ts.isStringLiteralLike(e.arguments[0])
      ? e.arguments[0].text
      : undefined
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteralLike(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text
      const clause = st.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) bindModule(spec, 'ns', clause.name.text)
      const nb = clause.namedBindings
      if (nb && ts.isNamespaceImport(nb)) bindModule(spec, 'ns', nb.name.text)
      if (nb && ts.isNamedImports(nb))
        for (const el of nb.elements)
          if (!el.isTypeOnly)
            bindModule(spec, 'named', el.name.text, (el.propertyName ?? el.name).text)
    } else if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteralLike(st.moduleReference.expression)
    ) {
      bindModule(st.moduleReference.expression.text, 'ns', st.name.text)
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const spec = requireOf(d.initializer)
        if (!spec) continue
        if (ts.isIdentifier(d.name)) bindModule(spec, 'ns', d.name.text)
        else if (ts.isObjectBindingPattern(d.name))
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name)) continue
            const imported =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : el.name.text
            bindModule(spec, 'named', el.name.text, imported)
          }
      }
    }
  }
  return b
}

async function scanFile(ctx: ScanContext): Promise<Registration[]> {
  const { ts, sf, path } = ctx
  const b = collectBindings(ts, sf)
  const hasElectron = b.electronNamed.size > 0 || b.electronNs.size > 0
  const hasExpress = b.expressNs.size > 0 || b.expressRouter.size > 0
  if (!hasElectron && !hasExpress) return []

  /** `ipcMain` / `ipcRenderer` when `e` is that electron export, else undefined. */
  const electronObject = (e: TS.Expression): string | undefined => {
    if (ts.isIdentifier(e)) return b.electronNamed.get(e.text)
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      b.electronNs.has(e.expression.text)
    )
      return e.name.text === 'ipcMain' || e.name.text === 'ipcRenderer' ? e.name.text : undefined
    return undefined
  }
  /** Express apps and routers created in this file: local name → router-relative paths. */
  const expressApps = new Map<string, boolean>()
  const expressFactory = (e: TS.Expression | undefined): boolean | undefined => {
    if (!e || !ts.isCallExpression(e)) return undefined
    const c = e.expression
    if (ts.isIdentifier(c) && b.expressNs.has(c.text)) return false
    if (ts.isIdentifier(c) && b.expressRouter.has(c.text)) return true
    if (
      ts.isPropertyAccessExpression(c) &&
      ts.isIdentifier(c.expression) &&
      b.expressNs.has(c.expression.text)
    )
      return c.name.text === 'Router' ? true : undefined
    return undefined
  }

  const found: Promise<Registration | null>[] = []
  const visit = (n: TS.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const router = expressFactory(n.initializer)
      if (router !== undefined) expressApps.set(n.name.text, router)
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const callee = n.expression
      const method = callee.name.text
      const obj = electronObject(callee.expression)
      if (obj === 'ipcMain' && IPC_HANDLE.has(method) && n.arguments.length >= 2) {
        found.push(registration(ctx, n, 'electron-ipc', ctx.scope, 'provide', n.arguments[1]))
      } else if (obj === 'ipcRenderer' && method === 'invoke' && n.arguments.length >= 1) {
        found.push(registration(ctx, n, 'electron-ipc', ctx.scope, 'invoke'))
      } else if (
        HTTP_METHODS.has(method) &&
        ts.isIdentifier(callee.expression) &&
        expressApps.has(callee.expression.text) &&
        n.arguments.length >= 2
      ) {
        const app = callee.expression.text
        found.push(
          registration(
            ctx,
            n,
            'http',
            `${path}#${app}`,
            'provide',
            n.arguments[n.arguments.length - 1],
            method.toUpperCase(),
            expressApps.get(app)
          )
        )
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return (await Promise.all(found)).filter((r): r is Registration => r !== null)
}

async function registration(
  ctx: ScanContext,
  call: TS.CallExpression,
  protocol: CatalogProtocol,
  scope: string,
  role: Registration['role'],
  handler?: TS.Expression,
  httpMethod?: string,
  routerRelative?: boolean
): Promise<Registration | null> {
  const { ts, sf, path } = ctx
  const callee = call.expression as TS.PropertyAccessExpression
  const arg = call.arguments[0]
  let address = await addressOf(ctx, arg)
  if (protocol === 'http') {
    // Only absolute literal paths are routes; anything else is an unknown address.
    if (address && !address.value.startsWith('/')) address = null
    if (address) address = { ...address, value: `${httpMethod} ${address.value}` }
  }
  // The index records calls at the callee name; reuse its enclosing symbol and edge ID.
  const callEdge = ctx.edgesAtSite
    .get(spanKey(spanOf(sf, path, callee.name)))
    ?.find((e) => e.kind === 'calls')
  const reg: Registration = {
    protocol,
    scope,
    address,
    text: arg.getText(sf).slice(0, 80),
    site: spanOf(sf, path, call),
    role,
    callerId: callEdge?.from,
    evidenceId: callEdge?.id,
    routerRelative
  }
  if (handler && (ts.isIdentifier(handler) || ts.isPropertyAccessExpression(handler))) {
    const name = ts.isIdentifier(handler) ? handler : handler.name
    const site = spanOf(sf, path, name)
    const ref = ctx.edgesAtSite
      .get(spanKey(site))
      ?.find((e) => e.role === 'callback-argument' && e.resolution === 'resolved' && e.to)
    if (ref) {
      reg.handlerId = ref.to!
      reg.handlerSource = {
        path,
        span: spanOf(sf, path, handler),
        evidenceId: ref.id,
        field: 'handlerId'
      }
    }
  }
  return reg
}

async function addressOf(ctx: ScanContext, arg: TS.Expression): Promise<Address> {
  const { ts, sf, path } = ctx
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { value: arg.text, sources: [{ path, span: spanOf(sf, path, arg), field: 'address' }] }
  }
  if (ts.isPropertyAccessExpression(arg)) return ctx.resolveConst(spanOf(sf, path, arg.name))
  return null
}

/**
 * `X.y` resolves only when the index links the `y` site to a property node whose declaration is
 * `y: '<literal>'` inside `const X = { … } as const`. Mutable objects stay unknown.
 */
async function resolveConstString(
  ts: TsModule,
  site: SourceSpan,
  edgesAtSite: Map<string, GraphEdge[]>,
  nodesById: Map<string, GraphNode>,
  parse: (path: string) => Promise<TS.SourceFile | null>
): Promise<Address> {
  const ref = edgesAtSite
    .get(spanKey(site))
    ?.find((e) => e.kind === 'references' && e.resolution === 'resolved' && e.to)
  const prop = ref ? nodesById.get(ref.to!) : undefined
  if (!prop || prop.kind !== 'property' || !prop.span) return null
  const sf = await parse(prop.span.path)
  if (!sf) return null
  const at = sf.getPositionOfLineAndCharacter(prop.span.start.line, prop.span.start.character)
  let n: TS.Node | undefined = findNodeAt(ts, sf, at)
  while (n && !ts.isPropertyAssignment(n)) n = n.parent
  if (!n || !ts.isPropertyAssignment(n)) return null
  const init = n.initializer
  if (!ts.isStringLiteral(init) && !ts.isNoSubstitutionTemplateLiteral(init)) return null
  const obj = n.parent
  const asConst = obj.parent
  if (
    !ts.isObjectLiteralExpression(obj) ||
    !ts.isAsExpression(asConst) ||
    !ts.isTypeReferenceNode(asConst.type) ||
    asConst.type.typeName.getText(sf) !== 'const'
  )
    return null
  const decl = asConst.parent
  if (
    !ts.isVariableDeclaration(decl) ||
    !ts.isVariableDeclarationList(decl.parent) ||
    !(decl.parent.flags & ts.NodeFlags.Const)
  )
    return null
  return {
    value: init.text,
    sources: [
      {
        path: prop.span.path,
        span: spanOf(sf, prop.span.path, n),
        evidenceId: prop.id,
        field: 'address'
      },
      { path: site.path, span: site, evidenceId: ref!.id, field: 'address' }
    ]
  }
}

// ---- Utilities -----------------------------------------------------------------------------------

function createSource(ts: TsModule, path: string, text: string): TS.SourceFile {
  const kind = /\.[mc]?tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[mc]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(path)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
}

function findNodeAt(ts: TsModule, sf: TS.SourceFile, pos: number): TS.Node | undefined {
  let found: TS.Node | undefined
  const visit = (n: TS.Node): void => {
    if (n.getStart(sf) <= pos && pos < n.getEnd()) {
      found = n
      ts.forEachChild(n, visit)
    }
  }
  ts.forEachChild(sf, visit)
  return found
}

function spanOf(sf: TS.SourceFile, path: string, n: TS.Node): SourceSpan {
  const start = sf.getLineAndCharacterOfPosition(n.getStart(sf))
  const end = sf.getLineAndCharacterOfPosition(n.getEnd())
  return { path, start, end }
}

function spanKey(s: SourceSpan): string {
  return `${s.path}:${s.start.line}:${s.start.character}:${s.end.line}:${s.end.character}`
}

function moduleId(root: string): string {
  return `module:npm:${root}`
}

function dedupeSources(sources: CatalogSource[]): CatalogSource[] {
  const seen = new Map<string, CatalogSource>()
  for (const s of sources) {
    const key = JSON.stringify([
      s.path,
      s.span && spanKey(s.span),
      s.field ?? '',
      s.evidenceId ?? ''
    ])
    if (!seen.has(key)) seen.set(key, s)
  }
  return [...seen]
    .sort(([a], [b]) => cmp(a, b))
    .map(
      ([, s]) =>
        Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as CatalogSource
    )
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
