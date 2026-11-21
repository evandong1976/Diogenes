import { createWriteStream } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { getAuthorizedRepo, githubFetch, onSessionChange, sessionGeneration } from '../github'
import type { SourceHost, SourceRepo } from './service'

const repoPath = (fullName: string): string =>
  fullName
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/')

/** SourceHost over the signed-in GitHub session. The token stays inside `githubFetch`. */
export const githubSourceHost: SourceHost = {
  generation: sessionGeneration,
  onSessionChange,

  getRepo: (id, signal) => getAuthorizedRepo(id, signal),

  async resolveCommit(repo: SourceRepo, signal?: AbortSignal) {
    const ref = repo.defaultBranch
    const res = await githubFetch(
      `/repos/${repoPath(repo.fullName)}/commits/${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.sha', signal }
    )
    if (res.status === 409) throw new Error(`${repo.fullName} is empty; there is nothing to index.`)
    if (res.status === 404 || res.status === 422) {
      throw new Error(`Default branch ${ref} was not found in ${repo.fullName}.`)
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} resolving ${ref}.`)
    const sha = (await res.text()).trim()
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error(`GitHub returned an invalid commit SHA for ${ref}.`)
    return { sha, ref }
  },

  async downloadArchive(repo, sha, dest, maxBytes, signal) {
    // Redirects to codeload.github.com with a short-lived token in the URL.
    const res = await githubFetch(`/repos/${repoPath(repo.fullName)}/tarball/${sha}`, {
      accept: 'application/vnd.github+json',
      signal
    })
    if (!res.ok || !res.body)
      throw new Error(`GitHub API ${res.status} downloading ${sha.slice(0, 7)}.`)
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new Error(`Repository archive is larger than ${maxBytes} bytes.`)
    let seen = 0
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length
        if (seen > maxBytes) cb(new Error(`Repository archive is larger than ${maxBytes} bytes.`))
        else cb(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      cap,
      createWriteStream(dest, { flags: 'wx' }),
      { signal }
    )
  }
}
