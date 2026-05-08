import React from 'react'
import ReactDOM from 'react-dom/client'
import './style.css'
import './i18n'
import App from './App'
import { initializeTheme } from './lib/theme'

initializeTheme()

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

