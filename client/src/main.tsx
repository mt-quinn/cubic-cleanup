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
//
// We trim the env var because hosts like Vercel preserve any whitespace
// the operator accidentally pastes into the value field. A leading
// space would make the URL fail to parse and the Convex client would
// silently never open a connection — extremely confusing to debug.
const rawConvexUrl = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim()
const convexUrl =
  rawConvexUrl && rawConvexUrl.length > 0 ? rawConvexUrl : 'http://127.0.0.1:3210'
const convex = new ConvexReactClient(convexUrl)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
)
