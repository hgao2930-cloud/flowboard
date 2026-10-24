<template>
  <main class="invalid-room">
    <h1>房间地址无效</h1>
    <p>房间号须为 1～64 位字母、数字、短横线或下划线。</p>
    <RouterLink to="/">返回首页</RouterLink>
  </main>
</template>

<style scoped>
.invalid-room {
  padding: 15vh 24px;
  text-align: center;
  color: #263d36;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.invalid-room a {
  color: #28735c;
}
.invalid-room a:focus-visible {
  outline: 3px solid #9ac6b4;
  outline-offset: 4px;
}
</style>
