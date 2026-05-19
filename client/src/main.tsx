import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import './index.css'
import App from './App.tsx'

// We always render a ConvexProvider so the multiplayer hooks (useQuery /
// useMutation) can call into the Convex client unconditionally. When no
// VITE_CONVEX_URL is configured we fall back to a localhost stub: the
// client never tries to connect because we never issue any queries
// without a room code, and missing-URL deploys keep working as a
// single-player offline build.
const convexUrl =
  (import.meta.env.VITE_CONVEX_URL as string | undefined) ??
  'http://127.0.0.1:3210'
const convex = new ConvexReactClient(convexUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
)
