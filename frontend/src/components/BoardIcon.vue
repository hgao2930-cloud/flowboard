<script setup lang="ts">
defineProps<{
  name:
    | 'plus'
    | 'close'
    | 'arrow-left'
    | 'undo'
    | 'redo'
    | 'trash'
    | 'copy'
    | 'fit'
    | 'minus'
    | 'link'
    | 'chevron'
    | 'card'
    | 'cursor'
    | 'check'
}>()
const paths = {
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  'arrow-left': 'M19 12H5m6-6-6 6 6 6',
  undo: 'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',
  redo: 'm15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  copy: 'M8 8h12v13H8zM16 8V3H3v13h5',
  fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z',
  minus: 'M5 12h14',
  link: 'm10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 4 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  chevron: 'm9 5 7 7-7 7',
  card: 'M4 4h16v16H4zM8 9h8m-8 5h5',
  cursor: 'm5 3 15 10-7 1-3 7z',
  check: 'm5 12 4 4L19 6',
}
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
