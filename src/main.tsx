import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import MobileApp from './MobileApp.tsx'

const isMobileRoute =
  window.location.pathname.startsWith('/mobile') ||
  new URLSearchParams(window.location.search).has('mobile')

createRoot(document.getElementById('root')!).render(
  isMobileRoute ? <MobileApp /> : <App />,
)
