import '@fontsource-variable/manrope'
import '@fontsource/pixelify-sans/400.css'
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
