import './styles/tokens.css'

import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'

import App from './App.vue'
import { buildRouter } from './router'

const router = buildRouter(createWebHistory())
const app = createApp(App).use(router)

// Mounted once the first view's script is in: the shell and the view are then drawn together, instead of a shell
// with an empty middle that fills in a moment later.
void router.isReady().then(() => app.mount('#app'))
