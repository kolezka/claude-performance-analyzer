// DeepSeek Harness entry for this Claude Code plugin. The plugin tree is read as is.
// Run `bun install --frozen-lockfile` in this directory before loading it.
import { createPlugin, rootFrom } from 'claude-plugin-dsh'

const plugin = createPlugin({ root: rootFrom(import.meta.url) })
export const { name, apply } = plugin
export default plugin
