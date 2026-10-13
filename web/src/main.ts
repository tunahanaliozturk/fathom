import './styles/tokens.css'

import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'

import App from './App.vue'
import { buildRouter } from './router'

createApp(App).use(buildRouter(createWebHistory())).mount('#app')
