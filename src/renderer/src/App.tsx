import { useState } from 'react'

const LEVELS = ['Infrastructure', 'Integrations', 'Code logic'] as const

function App(): React.JSX.Element {
  const [level, setLevel] = useState(0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <nav style={{ display: 'flex', gap: 8, padding: 12, borderBottom: '1px solid #333' }}>
        <strong style={{ marginRight: 16 }}>Diogenes</strong>
        {LEVELS.map((name, i) => (
          <button key={name} onClick={() => setLevel(i)} aria-pressed={level === i}>
            L{i + 1} · {name}
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: 0.5 }}>
        Canvas: {LEVELS[level]}
      </main>
    </div>
  )
}

export default App
