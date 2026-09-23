/**
 * Quick commands: short prompts kept on the PC in <data dir>/commands.json and
 * shared by every phone. One tap fills one into the composer; the user still
 * presses send. The file may be edited by hand; a broken file is reported,
 * never silently overwritten (saving keeps a .bak of it first).
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MAX = 30

export const DEFAULTS = [
  { id: 'test', label: '跑测试', text: '跑一遍测试；有失败的先修好再跑，直到全部通过。' },
  { id: 'sum', label: '总结改动', text: '总结一下这个项目今天改了什么：按文件列出要点，最后列出还没做完的事。' },
  { id: 'why', label: '解释报错', text: '解释一下刚才的报错：原因是什么、怎么修？先别改代码。' },
  { id: 'commit', label: '提交代码', text: '检查一遍改动，写好提交说明后提交（不要推送）。' },
  { id: 'go', label: '继续', text: '继续。' },
]

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'bad-commands' })

/** Normalize a list from the phone or the file; throws a 400 on anything else. */
export function validate(items) {
  if (!Array.isArray(items)) throw bad('指令列表格式不对')
  if (items.length > MAX) throw bad(`最多 ${MAX} 条`)
  const seen = new Set()
  return items.map((c) => {
    const label = String((c && c.label) || '').trim()
    const text = String((c && c.text) || '').trim()
    if (!label || !text) throw bad('名称和内容都不能为空')
    if ([...label].length > 16) throw bad('名称最多 16 个字')
    if (text.length > 2000) throw bad('内容最多 2000 字')
    let id = c && typeof c.id === 'string' && /^[a-z0-9-]{1,24}$/.test(c.id) ? c.id : ''
    while (!id || seen.has(id)) id = crypto.randomBytes(4).toString('hex')
    seen.add(id)
    return { id, label, text }
  })
}

/** { items, note? }: the saved list, the defaults when there is none, and why when the file is broken. */
export function load(dir) {
  const file = path.join(dir, 'commands.json')
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return { items: validate(DEFAULTS) } }
  try { return { items: validate(JSON.parse(raw).items) } } catch (err) {
    return { items: validate(DEFAULTS), note: `电脑上的 commands.json 有误（${err.message}），先显示默认指令；保存会覆盖它，原文件留一份 .bak` }
  }
}

/** Validate and write atomically; a file that did not parse is kept as commands.json.bak. */
export function save(dir, items) {
  const list = validate(items)
  const file = path.join(dir, 'commands.json')
  fs.mkdirSync(dir, { recursive: true })
  if (load(dir).note) fs.copyFileSync(file, file + '.bak')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ items: list }, null, 1) + '\n')
  fs.renameSync(tmp, file)
  return { items: list }
}
