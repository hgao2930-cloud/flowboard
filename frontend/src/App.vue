<template>
  <RouterView v-slot="{ Component, route }">
    <component :is="Component" :key="route.path" />
  </RouterView>
</template>

<script setup lang="ts"></script>

<style scoped></style>
