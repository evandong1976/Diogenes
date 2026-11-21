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
      <h1>Diogenes</h1>
      <p className="muted">See your architecture. Plan changes on a canvas.</p>
      {code ? (
        <>
          <p>Enter this code on GitHub:</p>
          <output className="code" aria-live="polite">
            {code.userCode}
          </output>
          <button onClick={() => navigator.clipboard.writeText(code.userCode)}>Copy code</button>
          <p className="muted">
            Waiting for approval at{' '}
            <a href={code.verificationUri} target="_blank" rel="noreferrer">
              {code.verificationUri}
            </a>
            …
          </p>
          <button className="link" onClick={signIn}>
            Get a new code
          </button>
        </>
      ) : (
        <button className="primary" onClick={signIn}>
          Sign in with GitHub
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
