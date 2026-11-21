// What each snapshot path is, and whether the TS/JS indexer needs it on disk.

const TS_JS: Record<string, 'typescript' | 'javascript'> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript'
}

const UNSUPPORTED: Record<string, string> = {
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.fs': 'fsharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-c',
  '.swift': 'swift',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.lua': 'lua',
  '.r': 'r',
  '.jl': 'julia',
  '.zig': 'zig',
  '.sh': 'shell',
  '.bash': 'shell',
  '.sql': 'sql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.sol': 'solidity'
}

export type PathClass = {
  /** Write the file into the snapshot. */
  extract: boolean
  language: string | null
  /** True for files the TS/JS indexer is expected to cover. */
  source: boolean
  reason: string
}

function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function classifyPath(path: string): PathClass {
  if (/(^|\/)node_modules\//.test(path)) {
    return { extract: false, language: null, source: false, reason: 'vendored-dependency' }
  }
  // AppleDouble metadata (`._name`) from archives made on macOS; never real source.
  if (/(^|\/)\._[^/]*$/.test(path)) {
    return { extract: false, language: null, source: false, reason: 'non-source' }
  }
  const ext = extname(path)
  const tsjs = TS_JS[ext]
  if (tsjs) return { extract: true, language: tsjs, source: true, reason: 'not-in-index' }
  // Compose files: catalog discovery reads them for datastore and broker resources.
  if (/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(path))
    return { extract: true, language: 'yaml', source: false, reason: 'non-source' }
  // Configs the analyzer reads: tsconfig/jsconfig, package.json, JSON modules.
  if (ext === '.json')
    return { extract: true, language: 'json', source: false, reason: 'non-source' }
  const other = UNSUPPORTED[ext]
  if (other)
    return { extract: false, language: other, source: false, reason: 'unsupported-language' }
  return { extract: false, language: null, source: false, reason: 'non-source' }
}

export function isSourcePath(path: string): boolean {
  return classifyPath(path).source
}
