import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Cargar from './Cargar.jsx'
import './styles.css'

// Dos vistas, un solo bundle. En el Centro de Desarrollo cada Board View apunta a
// su URL: la raíz es Configuración, /cargar es "Cargar comprobante". Va por ruta y
// no por ?vista=, porque monday le agrega sus propios parámetros a la URL.
const esCargar = window.location.pathname.replace(/\/+$/, '').endsWith('/cargar')
  || new URLSearchParams(window.location.search).get('vista') === 'cargar'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {esCargar ? <Cargar /> : <App />}
  </React.StrictMode>,
)
