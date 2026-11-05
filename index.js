/**
 * dsh-plugin-sticky-wall — 便签墙 · Host 半侧
 *
 * 职责只有三件事：
 *   1. 存：便签数组持久化到 `$DSH_HOME/sticky-wall.json`（默认 `~/.dsh/sticky-wall.json`），
 *      原子写（tmp + rename），进程内只有一份内存状态。
 *   2. 通道：在 webServer 上挂 `/api/dsh-sticky-wall/*` 同源 JSON 端点，给 Client 半侧读写。
 *   3. 工具：注册 4 个模型工具 `sticky_wall_*`，让「把这条记到便签墙」直接落到墙上。
 *
 * 说明：这里刻意不 import `@deepseek-ai/*`，只用 Node 内置模块 —— 插件装在 profile 里时
 * 宿主解析第三方包的 ESM 钩子不保证可用，零依赖最稳。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名 —— 与 package.json 的 name、cordis.patch.yml 的行 name 保持一致。 */
export const name = 'dsh-plugin-sticky-wall'

/** Host 硬依赖：HTTP 通道（webServer 由 web 载体提供）。 */
export const inject = ['webServer']

/** 端点前缀（Client 半侧同一常量）。 */
const API_PREFIX = '/api/dsh-sticky-wall'

/** 单文件上限：超过就拒绝（防误传大文件）。 */
const MAX_BODY_BYTES = 256 * 1024

/** 便签条数 / 正文长度上限。 */
const MAX_NOTES = 500
const MAX_TEXT = 4000

/** 便签尺寸：宽度（px）与「最少几行高」，两端都要夹。 */
const DEFAULT_W = 252
const MIN_W = 196
const MAX_W = 560
const DEFAULT_MIN_LINES = 3
const MIN_LINES = 1
const MAX_LINES_H = 30

/** 纸色枚举（顺序即 Client 调色板顺序）。 */
const COLORS = ['yellow', 'mint', 'sky', 'lilac', 'peach', 'rose', 'sand', 'slate']
const DEFAULT_COLOR = 'yellow'
const COLOR_LABEL = {
  yellow: '黄', mint: '薄荷', sky: '天蓝', lilac: '淡紫',
  peach: '蜜桃', rose: '樱粉', sand: '沙', slate: '石板',
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const clampNumber = (value, lo, hi, fallback) => (
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(hi, Math.max(lo, value))
    : fallback
)

const oneLine = (text, max = 60) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const stamp = (ms) => {
  const d = new Date(typeof ms === 'number' && Number.isFinite(ms) ? ms : Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const newId = (prefix = 'n') => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ---------------------------------------------------------------------------
// 行模型：一张便签 = 若干行，每行是 正文 / 待办 / 无序 / 有序 之一
// ---------------------------------------------------------------------------

/** 行种类。text = 普通段落，todo = 复选框，ul = 无序，ol = 有序。 */
const KINDS = ['text', 'todo', 'ul', 'ol']

/** 单行上限 / 单张便签最多行数。 */
const MAX_LINE_CHARS = 1000
const MAX_LINES = 200

/** Markdown 风格的写法认成对应行种类 —— 模型贴过来的文本也能直接是清单。 */
const LINE_PREFIXES = [
  { kind: 'todo', re: /^[-*+]\s*\[([ xX])\]\s?(.*)$/ },
  { kind: 'todo', re: /^\[([ xX])\]\s?(.*)$/ },
  { kind: 'ul', re: /^[-*+]\s+(.*)$/ },
  { kind: 'ol', re: /^\d+[.)]\s+(.*)$/ },
]

/** 一行纯文本 → 行对象。 */
function lineFromText(raw, id) {
  const text = String(raw ?? '')
  for (const rule of LINE_PREFIXES) {
    const match = rule.re.exec(text)
    if (match === null) continue
    if (rule.kind === 'todo') {
      return { id: id ?? newId('l'), kind: 'todo', text: match[2].slice(0, MAX_LINE_CHARS), done: match[1].toLowerCase() === 'x' }
    }
    return { id: id ?? newId('l'), kind: rule.kind, text: match[1].slice(0, MAX_LINE_CHARS), done: false }
  }
  return { id: id ?? newId('l'), kind: 'text', text: text.slice(0, MAX_LINE_CHARS), done: false }
}

/** 正文（多行文本）→ 行数组。 */
function linesFromText(text) {
  const source = typeof text === 'string' ? text : ''
  return source.split('\n').slice(0, MAX_LINES).map((line) => lineFromText(line))
}

/** 行数组 → 正文（给工具输出 / 搜索用的可读文本）。 */
function textFromLines(lines) {
  let order = 0
  return (Array.isArray(lines) ? lines : []).map((line) => {
    if (line.kind === 'ol') {
      order += 1
      return `${order}. ${line.text}`
    }
    order = 0
    if (line.kind === 'todo') return `- [${line.done ? 'x' : ' '}] ${line.text}`
    if (line.kind === 'ul') return `- ${line.text}`
    return line.text
  }).join('\n')
}

/** 收敛一行：只留下知道的字段，长度与种类都夹住。 */
function normalizeLine(raw) {
  if (typeof raw === 'string') return lineFromText(raw)
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id.slice(0, 40) : newId('l'),
    kind: KINDS.includes(src.kind) ? src.kind : 'text',
    text: typeof src.text === 'string' ? src.text.slice(0, MAX_LINE_CHARS) : '',
    done: src.done === true,
  }
}

// ---------------------------------------------------------------------------
// 便签状态
// ---------------------------------------------------------------------------

/**
 * 把外部（HTTP / 工具）传来的字段收敛成一条合法便签。
 * 行是权威数据；只给了 text 就按 Markdown 前缀拆成行，保证老数据与工具写入都能用。
 * @param {unknown} raw 原始输入
 * @param {object|undefined} prev 已存在的同 id 便签（更新时提供，保留 createdAt）
 */
function normalizeNote(raw, prev) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const now = Date.now()
  const sourceLines = Array.isArray(src.lines)
    ? src.lines.slice(0, MAX_LINES).map(normalizeLine)
    : (typeof src.text === 'string'
        ? linesFromText(src.text.slice(0, MAX_TEXT))
        : (prev?.lines ?? linesFromText(prev?.text ?? '')))
  return {
    id: typeof src.id === 'string' && src.id !== '' ? src.id.slice(0, 60) : (prev?.id ?? newId()),
    lines: sourceLines,
    text: textFromLines(sourceLines).slice(0, MAX_TEXT),
    ruled: typeof src.ruled === 'boolean' ? src.ruled : (prev?.ruled ?? true),
    w: Math.round(clampNumber(src.w, MIN_W, MAX_W, prev?.w ?? DEFAULT_W)),
    minLines: Math.round(clampNumber(src.minLines, MIN_LINES, MAX_LINES_H, prev?.minLines ?? DEFAULT_MIN_LINES)),
    color: COLORS.includes(src.color) ? src.color : (prev?.color ?? DEFAULT_COLOR),
    x: clampNumber(src.x, 0, 92, prev?.x ?? 8),
    y: clampNumber(src.y, 0, 88, prev?.y ?? 8),
    pinned: typeof src.pinned === 'boolean' ? src.pinned : (prev?.pinned ?? false),
    z: clampNumber(src.z, 1, 1e9, prev?.z ?? now),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  }
}

/** 首次安装的欢迎便签（只在意文件不存在时写入，不覆盖用户数据）。 */
function seedNotes() {
  const t = Date.now()
  return [
    {
      id: newId(), color: 'yellow', pinned: true, x: 5, y: 6, z: 1, ruled: true,
      text: '欢迎来到便签墙 ✨\n\n- [ ] 点一下左边的方框，就是「做完了」\n- [ ] 敲「- 」「1. 」直接变成清单\n· 拖动纸条、双击空白都能用',
      createdAt: t, updatedAt: t,
    },
    {
      id: newId(), color: 'mint', pinned: false, x: 28, y: 14, z: 2, ruled: true,
      text: '也可以让我帮你记：\n\n说一句「把这条记到便签墙」，模型就会调用 sticky_wall_add 把内容贴到这里。\n\n- [ ] 把待办写成清单也能认',
      createdAt: t + 1, updatedAt: t + 1,
    },
  ]
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // ---- 存储路径 ----
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const storePath = join(home, 'sticky-wall.json')

  /** @type {Array<object>} */
  let notes = []

  function load() {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      const list = Array.isArray(raw?.notes) ? raw.notes : []
      notes = list.slice(0, MAX_NOTES).map((item) => {
        const n = normalizeNote(item, undefined)
        // 读盘不该刷新 updatedAt：沿用文件里的值，否则每次重启顺序全变
        return {
          ...n,
          createdAt: clampNumber(item?.createdAt, 0, 8.64e15, n.createdAt),
          updatedAt: clampNumber(item?.updatedAt, 0, 8.64e15, n.updatedAt),
        }
      })
      return true
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error(`[dsh-plugin-sticky-wall] 读取 ${storePath} 失败：`, error?.message || String(error))
      }
      return false
    }
  }

  let writeChain = Promise.resolve()

  /** 原子持久化：写 tmp → rename，写失败只记日志不抛（UI 仍可继续用）。 */
  function persist() {
    const payload = JSON.stringify({ version: 1, notes }, null, 2)
    const tmp = `${storePath}.${process.pid}.tmp`
    writeChain = writeChain
      .then(() => {
        mkdirSync(dirname(storePath), { recursive: true })
        writeFileSync(tmp, payload, 'utf8')
        renameSync(tmp, storePath)
      })
      .catch((error) => {
        try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓 */ }
        console.error('[dsh-plugin-sticky-wall] 持久化失败：', error?.message || String(error))
      })
    return writeChain
  }

  if (!existsSync(storePath)) {
    notes = seedNotes()
    persist().then(() => {
      console.log(`[dsh-plugin-sticky-wall] 已初始化 ${storePath}（${notes.length} 条欢迎便签）`)
    })
  } else if (!load()) {
    notes = []
  }

  // ---- 变更入口（HTTP 与工具共用同一套语义） ----

  /**
   * 批量 upsert：同 id 更新，缺 id 新建。
   * @returns {{ saved: Array<object>, skipped: number }}
   */
  function upsertMany(inputs) {
    const saved = []
    let skipped = 0
    for (const input of Array.isArray(inputs) ? inputs : []) {
      if (input === null || typeof input !== 'object') { skipped += 1; continue }
      const id = typeof input.id === 'string' ? input.id : ''
      const existing = id === '' ? undefined : notes.find((n) => n.id === id)
      const note = normalizeNote(input, existing)
      if (existing === undefined) {
        const hasText = typeof input.text === 'string' && input.text.trim() !== ''
        // 既没有 id 也没有正文的空壳请求直接丢弃，别在墙上留空白纸
        if (id === '' && !hasText) { skipped += 1; continue }
        if (notes.length >= MAX_NOTES) { skipped += 1; continue }
        notes.push(note)
      } else {
        Object.assign(existing, note)
      }
      saved.push(note)
    }
    if (saved.length > 0) persist()
    return { saved, skipped }
  }

  function removeNote(id) {
    const index = notes.findIndex((n) => n.id === id)
    if (index === -1) return false
    notes.splice(index, 1)
    persist()
    return true
  }

  function clearNotes() {
    const count = notes.length
    notes = []
    persist()
    return count
  }

  const sorted = () => [...notes].sort((a, b) => (a.z - b.z) || (a.updatedAt - b.updatedAt))

  // ---- HTTP 端点（Client 半侧同源 fetch） ----

  async function readJson(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.byteLength
      if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(buf)
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (raw === '') return {}
    return JSON.parse(raw)
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(payload)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url || '').split('?')[0]
      const action = route.startsWith(API_PREFIX) ? route.slice(API_PREFIX.length) : route
      try {
        if (req.method === 'GET' && (action === '/snapshot' || action === '/')) {
          sendJson(res, 200, { ok: true, notes: sorted(), colors: COLORS })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end('method not allowed')
          return
        }

        const body = await readJson(req)

        if (action === '/snapshot') {
          sendJson(res, 200, { ok: true, notes: sorted(), colors: COLORS })
          return
        }

        if (action === '/upsert') {
          const inputs = Array.isArray(body?.notes) ? body.notes : (body?.note ? [body.note] : [])
          if (inputs.length === 0) {
            sendJson(res, 400, { ok: false, error: '缺少 notes' })
            return
          }
          const result = upsertMany(inputs)
          sendJson(res, 200, { ok: true, notes: sorted(), saved: result.saved.map((n) => n.id), skipped: result.skipped })
          return
        }

        if (action === '/remove') {
          const ok = removeNote(typeof body?.id === 'string' ? body.id : '')
          sendJson(res, ok ? 200 : 404, ok
            ? { ok: true, notes: sorted() }
            : { ok: false, error: '未找到该便签' })
          return
        }

        if (action === '/clear') {
          const count = clearNotes()
          sendJson(res, 200, { ok: true, removed: count, notes: [] })
          return
        }

        sendJson(res, 404, { ok: false, error: `未知端点 ${action || '/'}` })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error?.message || String(error) })
      }
    },
  }), 'dsh-plugin-sticky-wall: http')

  // ---- 模型工具 ----

  /** 模型看到的一条便签（紧凑、可读）。 */
  function describeNote(note, index) {
    const pin = note.pinned ? '📌 ' : ''
    return `${index + 1}. ${pin}[${note.id}] ${COLOR_LABEL[note.color] || note.color} · ${stamp(note.updatedAt)}\n   ${oneLine(note.text, 200) || '（空白）'}`
  }

  function listNotesText(filter, query) {
    let list = sorted()
    if (filter === 'pinned') list = list.filter((n) => n.pinned)
    if (typeof query === 'string' && query.trim() !== '') {
      const needle = query.trim().toLowerCase()
      list = list.filter((n) => n.text.toLowerCase().includes(needle))
    }
    if (list.length === 0) return '便签墙是空的（没有匹配的便签）。'
    const shown = list.slice(0, 100)
    const head = `便签墙共 ${list.length} 条${list.length > shown.length ? `（只列前 ${shown.length} 条）` : ''}：`
    return [head, ...shown.map(describeNote)].join('\n')
  }

  const toolOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.content ?? '') }],
  }

  /**
   * 手搓的 ToolDefinition（不 import @deepseek-ai/dsh-tools，理由见文件头）。
   * @param {object} spec
   */
  function defineTool(spec) {
    const properties = {}
    const required = []
    for (const [key, param] of Object.entries(spec.parameters || {})) {
      const node = { type: param.type }
      if (param.description) node.description = param.description
      if (Array.isArray(param.enum)) node.enum = param.enum
      if (param.items) node.items = param.items
      properties[key] = node
      if (param.required) required.push(key)
    }
    return {
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: toolOutput,
      presentCall: spec.presentCall,
      async execute(args) {
        const input = args !== null && typeof args === 'object' ? args : {}
        for (const [key, param] of Object.entries(spec.parameters || {})) {
          const value = input[key]
          if (value === undefined || value === null) {
            if (param.required) throw new Error(`缺少必填参数 "${key}"`)
            continue
          }
          if (param.type === 'string' && typeof value !== 'string') throw new Error(`参数 "${key}" 应为字符串`)
          if (param.type === 'boolean' && typeof value !== 'boolean') throw new Error(`参数 "${key}" 应为布尔值`)
          if (param.type === 'string' && Array.isArray(param.enum) && !param.enum.includes(value)) {
            throw new Error(`参数 "${key}" 只能是 ${param.enum.map((v) => JSON.stringify(v)).join(' / ')}`)
          }
        }
        for (const key of Object.keys(input)) {
          if (!(key in (spec.parameters || {}))) throw new Error(`未知参数 "${key}"（可用: ${Object.keys(spec.parameters || {}).join(', ')}）`)
        }
        return { content: String(await spec.run(input)) }
      },
    }
  }

  const tools = [
    defineTool({
      name: 'sticky_wall_list',
      description: '读取便签墙上的便签（含 id、颜色、时间、正文）。用户问「便签墙上有什么」时用它；返回的 id 可传给 sticky_wall_update / sticky_wall_remove。',
      presentCall: (args) => ({ card: 'generic', title: '查看便签墙', kind: 'read', rawInput: args }),
      parameters: {
        filter: { type: 'string', enum: ['all', 'pinned'], description: 'all=全部（默认）；pinned=只看置顶' },
        query: { type: 'string', description: '按正文子串过滤（不区分大小写）' },
      },
      run: ({ filter, query }) => listNotesText(filter || 'all', query),
    }),
    defineTool({
      name: 'sticky_wall_add',
      description: '在便签墙上新建一条便签。用户说「记一下 / 记到便签墙 / 帮我存个便签」时用它；写短一点，便签纸适合一两句话。',
      presentCall: (args) => ({
        card: 'generic',
        title: `贴便签：${oneLine(args?.text, 32)}`,
        kind: 'edit',
        rawInput: args,
      }),
      parameters: {
        text: { type: 'string', required: true, description: '便签正文（支持换行，最多 4000 字）' },
        color: { type: 'string', enum: COLORS, description: '纸色，默认 yellow' },
        pinned: { type: 'boolean', description: '是否置顶（贴在最上层）' },
      },
      run: ({ text, color, pinned }) => {
        const trimmed = String(text ?? '').trim()
        if (trimmed === '') throw new Error('便签正文不能为空')
        const maxZ = notes.reduce((max, n) => Math.max(max, n.z), 0) + 1
        const { saved } = upsertMany([{ text: trimmed, color, pinned, z: maxZ }])
        const note = saved[0]
        return `已贴到便签墙：[${note.id}] ${COLOR_LABEL[note.color]}${note.pinned ? ' · 置顶' : ''}\n${oneLine(note.text, 120)}`
      },
    }),
    defineTool({
      name: 'sticky_wall_update',
      description: '修改便签墙上已有便签的正文 / 纸色 / 置顶状态。id 从 sticky_wall_list 的返回里取。',
      presentCall: (args) => ({
        card: 'generic',
        title: `改便签：${args?.id ?? ''}`,
        kind: 'edit',
        rawInput: args,
      }),
      parameters: {
        id: { type: 'string', required: true, description: '便签 id（形如 n-xxxxxx）' },
        text: { type: 'string', description: '新的正文（省略则不改）' },
        color: { type: 'string', enum: COLORS, description: '新的纸色（省略则不改）' },
        pinned: { type: 'boolean', description: '是否置顶（省略则不改）' },
      },
      run: ({ id, text, color, pinned }) => {
        const existing = notes.find((n) => n.id === id)
        if (existing === undefined) throw new Error(`未找到便签 ${id}（先用 sticky_wall_list 看看有哪些 id）`)
        const patch = { id }
        if (typeof text === 'string') patch.text = text
        if (typeof color === 'string') patch.color = color
        if (typeof pinned === 'boolean') patch.pinned = pinned
        if (Object.keys(patch).length === 1) throw new Error('没有要改的字段（text / color / pinned 至少给一个）')
        const { saved } = upsertMany([patch])
        return `已更新便签 [${saved[0].id}]：\n${oneLine(saved[0].text, 120)}`
      },
    }),
    defineTool({
      name: 'sticky_wall_remove',
      description: '从便签墙上删除一条便签（不可撤销）。',
      presentCall: (args) => ({ card: 'generic', title: `撕掉便签：${args?.id ?? ''}`, kind: 'delete', rawInput: args }),
      parameters: {
        id: { type: 'string', required: true, description: '便签 id' },
      },
      run: ({ id }) => {
        const note = notes.find((n) => n.id === id)
        if (note === undefined) throw new Error(`未找到便签 ${id}`)
        removeNote(id)
        return `已撕掉便签 [${id}]：${oneLine(note.text, 80)}`
      },
    }),
  ]

  ctx.inject(['tools'], (toolCtx) => {
    for (const tool of tools) toolCtx.tools.register(tool)
  })

  console.log(`[dsh-plugin-sticky-wall] 就绪：${storePath}（${notes.length} 条便签）`)
}
