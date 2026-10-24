import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const root = fileURLToPath(new URL('../src/', import.meta.url))
function components(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? components(path) : entry.name.endsWith('.vue') ? [path] : []
  })
}

// 类型检查不能替代 Vue 模板编译，直接使用 Vite 插件所用的 SFC 编译器检查。
for (const filename of components(root)) {
  test(`Vue 模板可编译：${relative(root, filename)}`, () => {
    const source = readFileSync(filename, 'utf8')
    const { descriptor, errors } = parse(source, { filename })
    assert.equal(errors.length, 0, errors.map((error) => String(error)).join('\n'))
    const id = 'template-check'
    const script =
      descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id }) : null
    if (!descriptor.template) return
    const template = compileTemplate({
      source: descriptor.template.content,
      filename,
      id,
      compilerOptions: { bindingMetadata: script?.bindings, expressionPlugins: ['typescript'] },
    })
    assert.equal(
      template.errors.length,
      0,
      template.errors.map((error) => String(error)).join('\n'),
    )
  })
}
