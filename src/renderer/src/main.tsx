import '@fontsource/manrope/400.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/manrope/700.css'
import '@fontsource/pixelify-sans/400.css'
// React Flow first, so the design system's port and node styles override it.
import '@xyflow/react/dist/style.css'
import '../../../design/tokens.css'
import './assets/app.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
