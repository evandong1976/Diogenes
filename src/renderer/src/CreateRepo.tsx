import { useState } from 'react'
import type { GithubRepo, GithubUser } from '../../preload'

type Props = {
  user: GithubUser
  onCreated: (repo: GithubRepo) => void
  onCancel: () => void
}

export function CreateRepo({ user, onCreated, onCancel }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onCreated(await window.api.github.createRepo({ name, description, private: isPrivate }))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <form className="screen" onSubmit={submit}>
      <span className="dg-label">New repository</span>
      <h1 className="title">Start from a blank canvas</h1>

      <label className="field">
        <span className="dg-label">Name</span>
        <span className="row prefix">
          <span className="dg-data">{user.login} /</span>
          <input
            className="dg-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[A-Za-z0-9._\-]{1,100}"
            title='Letters, numbers, ".", "-" or "_"'
            required
            autoFocus
            spellCheck={false}
          />
        </span>
      </label>

      <label className="field">
        <span className="dg-label">Description (optional)</span>
        <input
          className="dg-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={350}
        />
      </label>

      <fieldset className="field">
        <legend className="dg-label">Visibility</legend>
        <div className="segmented" role="group" aria-label="Visibility">
          <button type="button" aria-pressed={isPrivate} onClick={() => setIsPrivate(true)}>
            Private
          </button>
          <button type="button" aria-pressed={!isPrivate} onClick={() => setIsPrivate(false)}>
            Public
          </button>
        </div>
      </fieldset>

      <p className="dg-data">Created with a README so it has a main branch.</p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="row">
        <button type="button" className="dg-btn dg-btn--ghost" onClick={onCancel} disabled={busy}>
          Back
        </button>
        <button type="submit" className="dg-btn dg-btn--primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create repository'}
        </button>
      </div>
    </form>
  )
}
