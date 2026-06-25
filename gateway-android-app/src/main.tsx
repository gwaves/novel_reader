import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'
import App from './App'
import './styles/app.css'

if (Capacitor.isNativePlatform()) {
  void StatusBar.setOverlaysWebView({ overlay: false })
  void StatusBar.setStyle({ style: Style.Light })
  void StatusBar.setBackgroundColor({ color: '#f8fafc' })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
