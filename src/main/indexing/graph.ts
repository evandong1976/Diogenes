import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { builtinModules } from 'module'
import { join } from 'path'
import type * as TS from 'typescript'
import type { Document, Index, SymbolInformation } from '@scip-code/scip'
import {
  GRAPH_SCHEMA_VERSION,
  type AnalyzerInfo,
  type Coverage,
  type Diagnostic,
  type EdgeKind,
  type EdgeRole,
  type FileRecord,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type Provenance,
  type Resolution,
  type SoftwareGraph,
  type SourceSpan
} from '../../shared/indexing'
import { isSourcePath } from './languages'
import type { TsModule } from './scip'

const DEFINITION = 1
const BUILTINS = new Set(builtinModules)

export type BuildInput = {
  root: string
  repository: { id: number; fullName: string }
  commit: { sha: string; ref: string }
  analyzers: AnalyzerInfo[]
  analyzerConfigKey: string
  files: FileRecord[]
  index: Index
  ts: TsModule
  kindNames: Record<number, string>
  diagnostics: Diagnostic[]
}

type Range4 = [number, number, number, number]

function range4(r: number[]): Range4 {
  return r.length === 3 ? [r[0], r[1], r[0], r[2]] : [r[0], r[1], r[2], r[3]]
}
function rangeKey(path: string, r: Range4): string {
  return `${path}:${r.join(':')}`
}
function spanOf(path: string, r: Range4): SourceSpan {
  return { path, start: { line: r[0], character: r[1] }, end: { line: r[2], character: r[3] } }
}

/** `scheme manager package version descriptors`; double spaces escape a space. */
export function parseScipSymbol(
  symbol: string
): { manager: string; pkg: string; version: string; descriptors: string } | null {
  if (symbol.startsWith('local ')) return null
  const fields: string[] = []
  let i = 0
  let cur = ''
  while (i < symbol.length && fields.length < 4) {
    if (symbol[i] === ' ') {
      if (symbol[i + 1] === ' ') {
        cur += ' '
        i += 2
        continue
      }
      fields.push(cur)
      cur = ''
      i++
      continue
    }
    cur += symbol[i++]
  }
  if (fields.length < 4) return null
  const [, manager, pkg, version] = fields
  return { manager, pkg, version, descriptors: symbol.slice(i) }
}

function lastDescriptorName(descriptors: string): string {
  const m = descriptors.match(/(?:`([^`]+)`|([^/#.()[\]:!`]+))(?:\(\)\.|\.|#|\/|:|!)?$/)
  return m?.[1] ?? m?.[2] ?? descriptors
}

function hashId(prefix: string, key: string): string {
  return prefix + createHash('sha1').update(key).digest('hex').slice(0, 16)
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

type Decl = TS.Node

type FileCtx = {
  path: string
  sf: TS.SourceFile
  doc: Document
  occByRange: Map<string, string[]>
  /** Declarations that became nodes, for innermost-enclosing lookup. */
  scopes: { id: string; decl: Decl; start: number; end: number }[]
}

export async function buildGraph(input: BuildInput): Promise<SoftwareGraph> {
  const { ts, index, kindNames } = input
  const diagnostics = [...input.diagnostics]
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const nodeBySymbol = new Map<string, string>()
  const definedSymbols = new Set<string>()
  const moduleSymbolToFile = new Map<string, string>()
  const symbolInfo = new Map<string, SymbolInformation>()
  const consumed = new Set<string>()
  /** `path\0localSymbol` → module specifier that did not resolve. */
  const unresolvedImportLocals = new Map<string, string>()
  const missingDeps = new Set<string>()
  const files = new Map(input.files.map((f) => [f.path, { ...f }]))
  const ctxs: FileCtx[] = []
  const declToNode = new Map<Decl, string>()
  const contained = new Set<string>()

  const docs = index.documents.filter((d) => {
    // scip-typescript writes OS separators; the snapshot inventory always uses '/'.
    d.relativePath = d.relativePath.replace(/\\/g, '/')
    if (!files.has(d.relativePath)) {
      // e.g. the fallback tsconfig's own includes; not part of the snapshot inventory.
      return false
    }
    return true
  })

  // ---- Pass 1: definitions → nodes ------------------------------------------------------
  for (const doc of docs) {
    const path = doc.relativePath
    const rec = files.get(path)!
    rec.status = 'analyzed'
    delete rec.reason
    const text = await readFile(join(input.root, path), 'utf8')
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(ts, path))
    const ctx: FileCtx = { path, sf, doc, occByRange: new Map(), scopes: [] }
    ctxs.push(ctx)
    for (const s of doc.symbols) symbolInfo.set(s.symbol, s)

    for (const occ of doc.occurrences) {
      const key = rangeKey(path, range4(occ.range))
      const list = ctx.occByRange.get(key)
      if (list) {
        if (!list.includes(occ.symbol)) list.push(occ.symbol)
      } else ctx.occByRange.set(key, [occ.symbol])
    }

    const fileId = `file:${path}`
    const moduleOcc = doc.occurrences.find(
      (o) => o.symbolRoles & DEFINITION && kindNames[symbolInfo.get(o.symbol)?.kind ?? 0] === 'File'
    )
    nodes.set(fileId, {
      id: fileId,
      kind: 'file',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      extent: { path, start: { line: 0, character: 0 }, end: posOf(sf, sf.end) },
      language: rec.language ?? undefined,
      evidence: moduleOcc ? [{ analyzer: 'scip-typescript', symbol: moduleOcc.symbol }] : []
    })
    if (moduleOcc) {
      moduleSymbolToFile.set(moduleOcc.symbol, fileId)
      nodeBySymbol.set(moduleOcc.symbol, fileId)
    }
    const moduleDescriptors = moduleOcc
      ? (parseScipSymbol(moduleOcc.symbol)?.descriptors ?? '')
      : ''

    const declByName = indexDeclarations(ts, sf, path)
    for (const occ of doc.occurrences) {
      if (!(occ.symbolRoles & DEFINITION) || occ === moduleOcc) continue
      definedSymbols.add(occ.symbol)
      if (nodeBySymbol.has(occ.symbol)) continue
      const r = range4(occ.range)
      const decl = declByName.get(rangeKey(path, r))
      const isLocal = occ.symbol.startsWith('local ')
      let kind = decl ? kindFromDecl(ts, decl) : undefined
      if (kind === undefined) kind = kindFromScip(kindNames[symbolInfo.get(occ.symbol)?.kind ?? 0])
      if (!kind) continue
      if (isLocal && kind !== 'function' && kind !== 'class') continue

      const parsed = parseScipSymbol(occ.symbol)
      let rest = isLocal ? occ.symbol : (parsed?.descriptors ?? occ.symbol)
      if (!isLocal && moduleDescriptors && rest.startsWith(moduleDescriptors)) {
        rest = rest.slice(moduleDescriptors.length)
      }
      let id = `ts:${path}#${rest}`
      for (let n = 2; nodes.has(id); n++) id = `ts:${path}#${rest}~${n}`

      const info = symbolInfo.get(occ.symbol)
      const name =
        (decl && declName(ts, decl, sf)) ||
        info?.displayName ||
        (isLocal ? occ.symbol : lastDescriptorName(rest))
      const extent = decl
        ? spanFromOffsets(sf, path, decl.getStart(sf), decl.end)
        : occ.enclosingRange.length
          ? spanOf(path, range4(occ.enclosingRange))
          : undefined
      nodes.set(id, {
        id,
        kind,
        name,
        path,
        span: spanOf(path, r),
        extent,
        language: rec.language ?? undefined,
        evidence: [{ analyzer: 'scip-typescript', symbol: occ.symbol }]
      })
      nodeBySymbol.set(occ.symbol, id)
      if (decl) {
        declToNode.set(decl, id)
        ctx.scopes.push({ id, decl, start: decl.getStart(sf), end: decl.end })
      }
    }
  }

  // Containment: nearest enclosing declaration that is a node, else the file.
  for (const ctx of ctxs) {
    for (const s of ctx.scopes) {
      const node = nodes.get(s.id)!
      let parent: string = `file:${ctx.path}`
      for (let p = s.decl.parent; p; p = p.parent) {
        const pid = declToNode.get(p)
        if (pid) {
          parent = pid
          break
        }
      }
      addEdge({
        kind: 'contains',
        from: parent,
        to: node.id,
        resolution: 'resolved',
        provenance: ['scip', 'ts-ast'],
        site: node.extent ?? node.span!
      })
    }
  }
  for (const node of nodes.values()) {
    if (node.kind === 'file' || !node.path || contained.has(node.id)) continue
    addEdge({
      kind: 'contains',
      from: `file:${node.path}`,
      to: node.id,
      resolution: 'resolved',
      provenance: ['scip'],
      site: node.extent ?? node.span!
    })
  }

  // ---- Pass 2: AST sites joined to SCIP symbols ------------------------------------------
  for (const ctx of ctxs) {
    const { sf, path } = ctx
    ctx.scopes.sort((a, b) => a.start - b.start || b.end - a.end)
    const fileId = `file:${path}`
    const enclosing = (offset: number): string => {
      let best: { id: string; start: number; end: number } | null = null
      for (const s of ctx.scopes) {
        if (s.start > offset) break
        if (offset < s.end && (!best || s.end - s.start <= best.end - best.start)) best = s
      }
      return best?.id ?? fileId
    }
    const nodeSpan = (n: TS.Node): SourceSpan => spanFromOffsets(sf, path, n.getStart(sf), n.end)
    const symbolsAt = (span: SourceSpan): string[] => ctx.occByRange.get(spanKey(span)) ?? []

    const handleImport = (
      spec: TS.StringLiteralLike,
      role: EdgeRole,
      bindings: TS.Node[]
    ): void => {
      const site = nodeSpan(spec)
      consumed.add(spanKey(site))
      const text = spec.text
      const target = symbolsAt(site).find(
        (s) => moduleSymbolToFile.has(s) || !definedSymbols.has(s)
      )
      let to: string | null = null
      let resolution: Resolution = 'unresolved'
      let reason: string | undefined
      if (target && moduleSymbolToFile.has(target)) {
        to = moduleSymbolToFile.get(target)!
        resolution = 'resolved'
      } else if (target && !target.startsWith('local ')) {
        to = externalNode(target)
        resolution = 'external'
      } else if (text.startsWith('.') || text.startsWith('/')) {
        reason = 'module-not-found'
      } else if (text.startsWith('node:') || BUILTINS.has(packageOf(text))) {
        reason = 'node-builtin-types-unavailable'
      } else {
        reason = 'dependency-not-installed'
        missingDeps.add(packageOf(text))
      }
      addEdge({
        kind: 'imports',
        role,
        from: fileId,
        to,
        resolution,
        provenance: resolution === 'unresolved' ? ['ts-ast'] : ['ts-ast', 'scip'],
        site,
        target: { text, reason }
      })
      for (const b of bindings) {
        const bSite = nodeSpan(b)
        consumed.add(spanKey(bSite))
        const syms = symbolsAt(bSite)
        if (resolution === 'unresolved') {
          for (const s of syms) {
            if (s.startsWith('local ')) unresolvedImportLocals.set(`${path}\0${s}`, text)
          }
          addEdge({
            kind: 'imports',
            role: role === 're-export' ? 're-export' : 'binding',
            from: fileId,
            to: null,
            resolution: 'unresolved',
            provenance: ['ts-ast'],
            site: bSite,
            target: { text: `${b.getText(sf)} from ${text}`, reason }
          })
          continue
        }
        const r = resolveSymbols(syms, path)
        if (!r) continue
        addEdge({
          kind: 'imports',
          role: role === 're-export' ? 're-export' : 'binding',
          from: fileId,
          to: r.to,
          resolution: r.resolution,
          provenance: ['ts-ast', 'scip'],
          site: bSite,
          target: r.reason ? { text: b.getText(sf), reason: r.reason } : undefined
        })
      }
    }

    const handleCall = (call: TS.CallExpression | TS.NewExpression): void => {
      const callee = call.expression
      const nameNode = calleeName(ts, callee)
      const from = enclosing(call.getStart(sf))
      const site = nameNode ? nodeSpan(nameNode) : nodeSpan(callee)
      const role: EdgeRole | undefined = ts.isNewExpression(call) ? 'new' : undefined
      const text = callee.getText(sf).slice(0, 120)
      if (!nameNode) {
        addEdge({
          kind: 'calls',
          role,
          from,
          to: null,
          resolution: 'unresolved',
          provenance: ['ts-ast'],
          site,
          target: { text, reason: 'dynamic-callee' }
        })
      } else {
        consumed.add(spanKey(site))
        const r = resolveSymbols(symbolsAt(site), path)
        addEdge({
          kind: 'calls',
          role,
          from,
          to: r?.to ?? null,
          resolution: r?.resolution ?? 'unresolved',
          provenance: r ? ['ts-ast', 'scip'] : ['ts-ast'],
          site,
          target:
            !r || r.resolution === 'unresolved' || r.resolution === 'local'
              ? { text, reason: r?.reason ?? 'no-symbol-at-site' }
              : undefined
        })
      }
      for (const arg of call.arguments ?? []) {
        const argName = ts.isIdentifier(arg)
          ? arg
          : ts.isPropertyAccessExpression(arg)
            ? arg.name
            : null
        if (!argName) continue
        const aSite = nodeSpan(argName)
        const r = resolveSymbols(symbolsAt(aSite), path)
        if (!r || !isFunctionTarget(r.to, symbolsAt(aSite))) continue
        consumed.add(spanKey(aSite))
        addEdge({
          kind: 'references',
          role: 'callback-argument',
          from,
          to: r.to,
          resolution: r.resolution,
          provenance: ['ts-ast', 'scip'],
          site: aSite,
          target: { text: arg.getText(sf) }
        })
      }
    }

    const visit = (n: TS.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier)) {
        const b: TS.Node[] = []
        const clause = n.importClause
        if (clause?.name) b.push(clause.name)
        const nb = clause?.namedBindings
        if (nb && ts.isNamespaceImport(nb)) b.push(nb.name)
        if (nb && ts.isNamedImports(nb))
          for (const el of nb.elements) b.push(el.propertyName ?? el.name)
        handleImport(n.moduleSpecifier, 'module', b)
        // Aliased names (`format as formatDate`) carry the same symbol.
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements)
            if (el.propertyName) consumed.add(spanKey(nodeSpan(el.name)))
        }
        return
      }
      if (
        ts.isExportDeclaration(n) &&
        n.moduleSpecifier &&
        ts.isStringLiteralLike(n.moduleSpecifier)
      ) {
        const b: TS.Node[] = []
        if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const el of n.exportClause.elements) b.push(el.propertyName ?? el.name)
        }
        handleImport(n.moduleSpecifier, 're-export', b)
        return
      }
      if (
        ts.isImportEqualsDeclaration(n) &&
        ts.isExternalModuleReference(n.moduleReference) &&
        ts.isStringLiteralLike(n.moduleReference.expression)
      ) {
        handleImport(n.moduleReference.expression, 'module', [n.name])
        return
      }
      if (ts.isCallExpression(n)) {
        const arg0 = n.arguments[0]
        const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require'
        const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword
        if ((isRequire || isDynamicImport) && arg0 && ts.isStringLiteralLike(arg0)) {
          if (isRequire) consumed.add(spanKey(nodeSpan(n.expression)))
          handleImport(arg0, 'dynamic', [])
          return
        }
        if (n.expression.kind !== ts.SyntaxKind.SuperKeyword && !isDynamicImport) handleCall(n)
      } else if (ts.isNewExpression(n)) {
        handleCall(n)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)

    // Remaining SCIP references to repo-defined symbols.
    for (const occ of ctx.doc.occurrences) {
      if (occ.symbolRoles & DEFINITION) continue
      const span = spanOf(path, range4(occ.range))
      if (consumed.has(spanKey(span))) continue
      const to = nodeBySymbol.get(occ.symbol)
      if (!to || nodes.get(to)!.kind === 'file') continue
      const from = enclosing(offsetOf(sf, span.start))
      if (from === to) continue
      addEdge({
        kind: 'references',
        from,
        to,
        resolution: 'resolved',
        provenance: ['scip'],
        site: span
      })
    }
  }

  // ---- SCIP implementation relationships ------------------------------------------------
  for (const [symbol, info] of symbolInfo) {
    const from = nodeBySymbol.get(symbol)
    if (!from) continue
    for (const rel of info.relationships) {
      if (!rel.isImplementation) continue
      const to =
        nodeBySymbol.get(rel.symbol) ??
        (definedSymbols.has(rel.symbol) ? null : externalNode(rel.symbol))
      if (!to) continue
      const node = nodes.get(from)!
      addEdge({
        kind: 'implements',
        from,
        to,
        resolution: nodeBySymbol.has(rel.symbol) ? 'resolved' : 'external',
        provenance: ['scip'],
        site: node.span ?? node.extent!
      })
    }
  }

  // ---- Coverage and diagnostics ---------------------------------------------------------
  const fileList = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
  const sourceFiles = fileList.filter((f) => isSourcePath(f.path) && f.status !== 'rejected')
  const skippedByReason: Record<string, number> = {}
  const unsupportedLanguages: Record<string, number> = {}
  for (const f of fileList) {
    if (f.status === 'analyzed') continue
    if (f.reason) skippedByReason[f.reason] = (skippedByReason[f.reason] ?? 0) + 1
    if (f.reason === 'unsupported-language' && f.language) {
      unsupportedLanguages[f.language] = (unsupportedLanguages[f.language] ?? 0) + 1
    }
  }
  const edgeList = [...edges.values()]
  const edgesByKind: Coverage['edgesByKind'] = {}
  const edgesByResolution: Coverage['edgesByResolution'] = {}
  for (const e of edgeList) {
    edgesByKind[e.kind] = (edgesByKind[e.kind] ?? 0) + 1
    edgesByResolution[e.resolution] = (edgesByResolution[e.resolution] ?? 0) + 1
  }
  const analyzedFiles = sourceFiles.filter((f) => f.status === 'analyzed').length
  const coverage: Coverage = {
    sourceFiles: sourceFiles.length,
    analyzedFiles,
    skippedFiles: sourceFiles.length - analyzedFiles,
    rejectedEntries: fileList.filter((f) => f.status === 'rejected').length,
    skippedByReason,
    unsupportedLanguages,
    missingDependencies: [...missingDeps].sort(),
    nodes: nodes.size,
    edges: edgeList.length,
    edgesByKind,
    edgesByResolution
  }
  if (missingDeps.size) {
    diagnostics.push({
      severity: 'warning',
      code: 'dependencies-not-installed',
      message: `Imports of ${missingDeps.size} package(s) are unresolved because indexing never installs dependencies: ${[...missingDeps].sort().slice(0, 20).join(', ')}${missingDeps.size > 20 ? ', …' : ''}`
    })
  }
  const notIndexed = sourceFiles.filter((f) => f.status !== 'analyzed')
  if (notIndexed.length) {
    diagnostics.push({
      severity: 'warning',
      code: 'source-not-indexed',
      message: `${notIndexed.length} TS/JS file(s) were not indexed (outside every tsconfig, too large, or failed).`
    })
  }
  if (Object.keys(unsupportedLanguages).length) {
    diagnostics.push({
      severity: 'info',
      code: 'unsupported-languages',
      message: `No indexer yet for: ${Object.entries(unsupportedLanguages)
        .map(([l, n]) => `${l} (${n})`)
        .join(', ')}`
    })
  }
  for (const f of fileList.filter((f) => f.status === 'rejected')) {
    diagnostics.push({
      severity: 'warning',
      code: f.reason ?? 'rejected',
      message: 'Archive entry rejected.',
      path: f.path
    })
  }

  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    repository: input.repository,
    commit: input.commit,
    analyzers: input.analyzers,
    analyzerConfigKey: input.analyzerConfigKey,
    positionEncoding: 'utf-16',
    generatedAt: new Date().toISOString(),
    status: notIndexed.length === 0 ? 'complete' : 'partial',
    files: fileList,
    nodes: [...nodes.values()],
    edges: edgeList,
    coverage,
    diagnostics
  }

  // ---- helpers (closures over the maps above) -------------------------------------------

  function externalNode(symbol: string): string {
    const p = parseScipSymbol(symbol)
    const id = p ? `ext:${p.manager}:${p.pkg}:${p.descriptors}` : `ext:unknown:${symbol}`
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: 'external',
        name: p ? lastDescriptorName(p.descriptors) : symbol,
        external: p ? { manager: p.manager, package: p.pkg, version: p.version } : undefined,
        evidence: [{ analyzer: 'scip-typescript', symbol }]
      })
    }
    return id
  }

  /** Picks the best target among the symbols SCIP recorded at one site. */
  function resolveSymbols(
    syms: string[],
    path: string
  ): { to: string | null; resolution: Resolution; reason?: string } | null {
    if (!syms.length) return null
    for (const s of syms) {
      const id = nodeBySymbol.get(s)
      if (id) return { to: id, resolution: 'resolved' }
    }
    for (const s of syms) {
      if (!s.startsWith('local ') && !definedSymbols.has(s))
        return { to: externalNode(s), resolution: 'external' }
    }
    for (const s of syms) {
      const spec = unresolvedImportLocals.get(`${path}\0${s}`)
      if (spec) return { to: null, resolution: 'unresolved', reason: `import-unresolved:${spec}` }
    }
    return { to: null, resolution: 'local', reason: 'local-binding' }
  }

  function isFunctionTarget(to: string | null, syms: string[]): boolean {
    if (!to) return false
    const node = nodes.get(to)
    if (!node) return false
    if (node.kind === 'function' || node.kind === 'method' || node.kind === 'constructor')
      return true
    return node.kind === 'external' && syms.some((s) => s.endsWith(').'))
  }

  function addEdge(e: {
    kind: EdgeKind
    role?: EdgeRole
    from: string
    to: string | null
    resolution: Resolution
    provenance: Provenance[]
    site: SourceSpan
    target?: { text: string; reason?: string }
  }): void {
    const key = [
      e.kind,
      e.role ?? '',
      e.from,
      e.to ?? `?${e.target?.text}|${e.target?.reason}`
    ].join('\0')
    const existing = edges.get(key)
    if (existing) {
      if (!existing.sites.some((s) => spanKey(s) === spanKey(e.site))) existing.sites.push(e.site)
      for (const p of e.provenance)
        if (!existing.provenance.includes(p)) existing.provenance.push(p)
      return
    }
    if (e.kind === 'contains' && e.to) contained.add(e.to)
    const edge: GraphEdge = {
      id: hashId('e:', key),
      kind: e.kind,
      from: e.from,
      to: e.to,
      resolution: e.resolution,
      provenance: [...e.provenance],
      sites: [e.site]
    }
    if (e.role) edge.role = e.role
    if (e.target) edge.target = e.target.reason ? e.target : { text: e.target.text }
    edges.set(key, edge)
  }
}

function spanKey(s: SourceSpan): string {
  return `${s.path}:${s.start.line}:${s.start.character}:${s.end.line}:${s.end.character}`
}

function posOf(sf: TS.SourceFile, offset: number): { line: number; character: number } {
  return sf.getLineAndCharacterOfPosition(offset)
}

function offsetOf(sf: TS.SourceFile, p: { line: number; character: number }): number {
  try {
    return sf.getPositionOfLineAndCharacter(p.line, p.character)
  } catch {
    return 0
  }
}

function spanFromOffsets(sf: TS.SourceFile, path: string, start: number, end: number): SourceSpan {
  return { path, start: posOf(sf, start), end: posOf(sf, end) }
}

function scriptKind(ts: TsModule, path: string): TS.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX
  if (/\.[cm]?js$/i.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** Maps the span of each declaration's name to the declaration node. */
function indexDeclarations(ts: TsModule, sf: TS.SourceFile, path: string): Map<string, Decl> {
  const out = new Map<string, Decl>()
  const add = (nameNode: TS.Node, decl: Decl): void => {
    const s = spanFromOffsets(sf, path, nameNode.getStart(sf), nameNode.end)
    out.set(spanKey(s), decl)
  }
  const visit = (n: TS.Node): void => {
    if (ts.isConstructorDeclaration(n)) {
      const kw = n.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword)
      if (kw) add(kw, n)
    } else {
      const name = (n as { name?: TS.Node }).name
      if (
        name &&
        (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) &&
        isDeclaration(ts, n)
      ) {
        add(name, n)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function isDeclaration(ts: TsModule, n: TS.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isClassDeclaration(n) ||
    ts.isClassExpression(n) ||
    ts.isInterfaceDeclaration(n) ||
    ts.isTypeAliasDeclaration(n) ||
    ts.isEnumDeclaration(n) ||
    ts.isEnumMember(n) ||
    ts.isModuleDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isMethodSignature(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isPropertyDeclaration(n) ||
    ts.isPropertySignature(n) ||
    ts.isPropertyAssignment(n) ||
    ts.isVariableDeclaration(n) ||
    ts.isParameter(n) ||
    ts.isTypeParameterDeclaration(n)
  )
}

function unwrap(ts: TsModule, e: TS.Expression | undefined): TS.Expression | undefined {
  while (
    e &&
    (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))
  ) {
    e = e.expression
  }
  return e
}

function kindFromDecl(ts: TsModule, d: Decl): NodeKind | null {
  if (ts.isFunctionDeclaration(d) || ts.isFunctionExpression(d)) return 'function'
  if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return 'class'
  if (ts.isInterfaceDeclaration(d)) return 'interface'
  if (ts.isTypeAliasDeclaration(d)) return 'type'
  if (ts.isEnumDeclaration(d)) return 'enum'
  if (ts.isEnumMember(d)) return 'property'
  if (ts.isModuleDeclaration(d)) return 'namespace'
  if (ts.isConstructorDeclaration(d)) return 'constructor'
  if (
    ts.isMethodDeclaration(d) ||
    ts.isMethodSignature(d) ||
    ts.isGetAccessorDeclaration(d) ||
    ts.isSetAccessorDeclaration(d)
  ) {
    return 'method'
  }
  if (ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) {
    const init = unwrap(ts, d.initializer)
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ? 'method'
      : 'property'
  }
  if (ts.isPropertySignature(d)) return 'property'
  if (ts.isVariableDeclaration(d)) {
    const init = unwrap(ts, d.initializer)
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return 'function'
    if (init && ts.isClassExpression(init)) return 'class'
    return 'variable'
  }
  return null
}

function kindFromScip(name: string | undefined): NodeKind | null {
  switch (name) {
    case 'Class':
      return 'class'
    case 'Interface':
      return 'interface'
    case 'Function':
      return 'function'
    case 'Method':
    case 'AbstractMethod':
    case 'StaticMethod':
    case 'Getter':
    case 'Setter':
    case 'Accessor':
      return 'method'
    case 'Constructor':
      return 'constructor'
    case 'Property':
    case 'Field':
    case 'StaticProperty':
    case 'EnumMember':
      return 'property'
    case 'Variable':
    case 'Constant':
      return 'variable'
    case 'TypeAlias':
    case 'Type':
      return 'type'
    case 'Enum':
      return 'enum'
    case 'Namespace':
    case 'Module':
      return 'namespace'
    default:
      return null
  }
}

function declName(ts: TsModule, d: Decl, sf: TS.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(d)) return 'constructor'
  const name = (d as { name?: TS.Node }).name
  return name ? name.getText(sf) : undefined
}

/** The identifier that names what is being called, or null for computed callees. */
function calleeName(ts: TsModule, e: TS.Expression): TS.Node | null {
  e = unwrap(ts, e) ?? e
  if (ts.isNonNullExpression(e)) e = e.expression
  if (ts.isIdentifier(e)) return e
  if (ts.isPropertyAccessExpression(e)) return e.name
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression
  }
  return null
}
