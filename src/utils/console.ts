import process from 'node:process'

const TOOL_COLORS: Record<string, [string, string]> = {
  todowrite: ['Todo', '\u001B[33m\u001B[1m'],
  todoread: ['Todo', '\u001B[33m\u001B[1m'],
  bash: ['Bash', '\u001B[31m\u001B[1m'],
  edit: ['Edit', '\u001B[32m\u001B[1m'],
  glob: ['Glob', '\u001B[34m\u001B[1m'],
  grep: ['Grep', '\u001B[34m\u001B[1m'],
  list: ['List', '\u001B[34m\u001B[1m'],
  read: ['Read', '\u001B[35m\u001B[1m'],
  write: ['Write', '\u001B[32m\u001B[1m'],
  websearch: ['Search', '\u001B[2m\u001B[1m'],
} as const

const ANSI_RESET = '\u001B[0m'
const ANSI_DIM = '\u001B[0m\u001B[2m'

export function outputToolExecution(toolName: string, title: string): void {
  const [displayName, color] = TOOL_COLORS[toolName.toLowerCase()] ?? [toolName, '\u001B[36m\u001B[1m']
  const paddedName = displayName.padEnd(7, ' ')
  process.stdout.write(`\n${color}|${ANSI_RESET}${ANSI_DIM} ${paddedName} ${ANSI_RESET}${title}\n`)
}

export function outputTextContent(text: string): void {
  process.stdout.write(`\n${text}\n`)
}
