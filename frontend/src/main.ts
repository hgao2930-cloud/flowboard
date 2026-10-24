import { createApp } from 'vue'
import App from './App.vue'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import router from '@/router'

const app = createApp(App)
app.use(router)
app.mount('#app')
