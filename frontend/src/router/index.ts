import { createWebHistory, createRouter } from 'vue-router'
import { roomIdFromPath } from '@/rooms/roomId'

const routes = [
  { path: '/', component: () => import('@/views/HomeView.vue') },
  { path: '/board/:roomId', name: 'board', component: () => import('@/views/BoardView.vue') },
  {
    path: '/invalid-room',
    name: 'invalid-room',
    component: () => import('@/views/InvalidRoomView.vue'),
  },
  { path: '/board/:pathMatch(.*)*', component: () => import('@/views/InvalidRoomView.vue') },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: routes,
})
// 全局入口守卫也会处理 roomId 参数切换，非法编码不会进入 BoardView。
router.beforeEach((to) => {
  if (to.name === 'board' && !roomIdFromPath(to.path)) {
    return { name: 'invalid-room', replace: true }
  }
})
export default router
