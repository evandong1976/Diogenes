// Declaration adapters for manifests: package.json (Module, Workload), JSON Schema (Data Contract)
// and Compose files (Resource). Each reads one explicit declaration and never guesses.

import type { CatalogNode, CatalogProperties, CatalogSource } from '../../shared/catalog'
import type { SourceSpan } from '../../shared/indexing'

export type PackageManifest = {
  root: string
  path: string
  text: string
  name?: string
  main?: string
  bin: Record<string, string>
  dependencies: string[]
  electron: boolean
}

type ResourceType = CatalogProperties['resource']['resourceType']

export function moduleRootOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i)
}

/** The span of the first `"key"` in a JSON document, for drill-down to the declaring field. */
export function jsonKeySpan(path: string, text: string, key: string): SourceSpan | undefined {
  const needle = JSON.stringify(key)
  const at = text.indexOf(`${needle}:`) >= 0 ? text.indexOf(`${needle}:`) : text.indexOf(needle)
  return at < 0 ? undefined : spanAt(path, text, at, at + needle.length)
}

export function spanAt(path: string, text: string, from: number, to: number): SourceSpan {
  const pos = (offset: number): { line: number; character: number } => {
    const before = text.slice(0, offset)
    const line = before.split('\n').length - 1
    return { line, character: offset - (before.lastIndexOf('\n') + 1) }
  }
  return { path, start: pos(from), end: pos(to) }
}

export function parsePackage(path: string, text: string): PackageManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const pkg = raw as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const deps = new Set<string>()
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
  ]) {
    const d = pkg[field]
    if (d && typeof d === 'object') for (const k of Object.keys(d)) deps.add(k)
  }
  const bin: Record<string, string> = {}
  const name = str(pkg.name)
  if (typeof pkg.bin === 'string' && name) bin[name.replace(/^@[^/]+\//, '')] = pkg.bin
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [k, v] of Object.entries(pkg.bin)) if (typeof v === 'string') bin[k] = v
  }
  return {
    root: moduleRootOf(path),
    path,
    text,
    name,
    main: str(pkg.main),
    bin,
    dependencies: [...deps].sort(),
    electron: deps.has('electron')
  }
}

export function isJsonSchemaPath(path: string): boolean {
  return /\.schema\.json$/.test(path)
}

/** A JSON Schema document declares a Data Contract only when it names its `$schema` dialect. */
export function jsonSchemaContract(path: string, text: string): CatalogNode | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  const dialect = typeof doc.$schema === 'string' ? doc.$schema : undefined
  if (!dialect || !/json-schema\.org/.test(dialect)) return null
  const version = /(draft-\d+|\d{4}-\d{2})/.exec(dialect)?.[1]
  const sources: CatalogSource[] = [
    { path, field: 'format', span: jsonKeySpan(path, text, '$schema') }
  ]
  return {
    id: `dataContract:json-schema:${path}`,
    kind: 'dataContract',
    name: typeof doc.title === 'string' ? doc.title : path.slice(path.lastIndexOf('/') + 1),
    resolution: 'declared',
    properties: { format: 'json-schema', version },
    ports: [],
    sources
  }
}

export function isComposePath(path: string): boolean {
  return /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(path)
}

const IMAGE_TYPES: [RegExp, ResourceType][] = [
  [
    /^(postgres|postgis\/postgis|mysql|mariadb|mongo|redis|valkey\/valkey|elasticsearch|cassandra)\b/,
    'store'
  ],
  [/^(rabbitmq)\b/, 'queue'],
  [/^(bitnami\/kafka|confluentinc\/cp-kafka|apache\/kafka|nats)\b/, 'topic'],
  [/^(minio\/minio)\b/, 'bucket']
]

/**
 * Block-style Compose only: `services:` at column 0, two-space service keys, and a plain
 * `image:` scalar. Services built from source or with unknown images are not resources here.
 */
export function composeResources(path: string, text: string): CatalogNode[] {
  const lines = text.split('\n')
  const out: CatalogNode[] = []
  let inServices = false
  let service: { name: string; offset: number; end: number } | null = null
  let offset = 0
  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1
    if (/^\S/.test(line)) {
      inServices = /^services:\s*(#.*)?$/.test(line)
      service = null
      continue
    }
    if (!inServices) continue
    const key = /^ {2}([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(line)
    if (key) {
      service = { name: key[1], offset: lineStart + 2, end: lineStart + 2 + key[1].length }
      continue
    }
    const image = /^ {4}image:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line)
    if (!image || !service) continue
    const type = IMAGE_TYPES.find(([re]) => re.test(image[1]))?.[1]
    if (!type) continue
    const at = lineStart + line.indexOf(image[1])
    out.push({
      id: `resource:compose:${path}#${service.name}`,
      kind: 'resource',
      name: service.name,
      resolution: 'declared',
      properties: { resourceType: type, address: service.name },
      ports: [],
      sources: [
        { path, field: 'address', span: spanAt(path, text, service.offset, service.end) },
        { path, field: 'resourceType', span: spanAt(path, text, at, at + image[1].length) }
      ]
    })
  }
  return out
}
