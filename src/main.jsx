import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import WalkCycle from './WalkCycle.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WalkCycle />
  </StrictMode>,
)
