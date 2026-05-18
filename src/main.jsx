import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WalkCycleTool from '../walkcyclestudio.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WalkCycleTool />
  </StrictMode>,
)
