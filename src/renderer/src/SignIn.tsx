import { useState } from 'react'
import type { DeviceCode, GithubUser } from '../../preload'

export function SignIn({ onSignedIn }: { onSignedIn: (u: GithubUser) => void }): React.JSX.Element {
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const signIn = async (): Promise<void> => {
    setError(null)
    try {
      const c = await window.api.github.startLogin()
      setCode(c)
      onSignedIn(await window.api.github.finishLogin())
    } catch (e) {
      // A restarted flow rejects the old poll; the new one is still running.
      if ((e as Error).message.includes('restarted')) return
      setCode(null)
      setError((e as Error).message)
    }
  }

  return (
    <div className="screen">
      <span className="dg-label">Diogenes · v0.1</span>
      <h1 className="display">Draw the system.</h1>
      <p className="muted">See your architecture. Plan changes on a canvas.</p>
      {code ? (
        <>
          <span className="dg-label">Enter this code on GitHub</span>
          <div className="row">
            <output className="code" aria-live="polite">
              {code.userCode}
            </output>
            <button className="dg-btn" onClick={() => navigator.clipboard.writeText(code.userCode)}>
              Copy
            </button>
          </div>
          <p className="muted">
            Waiting for approval at{' '}
            <a href={code.verificationUri} target="_blank" rel="noreferrer">
              {code.verificationUri}
            </a>
            …
          </p>
          <div>
            <button className="dg-btn dg-btn--ghost" onClick={signIn}>
              Get a new code
            </button>
          </div>
        </>
      ) : (
        <div>
          <button className="dg-btn dg-btn--primary" onClick={signIn}>
            Sign in with GitHub
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
