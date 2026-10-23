import { mount } from 'svelte'

import App from './App.svelte'
import './app.css'

const target = document.querySelector('#app')

if (!target) {
  throw new Error('Missing #app mount target')
}

export default mount(App, { target })
