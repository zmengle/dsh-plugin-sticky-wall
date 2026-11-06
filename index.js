/**
 * dsh-plugin-sticky-wall — 便签墙 · Host 半侧
 *
 * 职责只有三件事：
 *   1. 存：便签数组持久化到 `$DSH_HOME/sticky-wall.json`（默认 `~/.dsh/sticky-wall.json`，
 *      可用插件配置 `storePath` 改成别的路径），原子写（tmp + rename），进程内只有一份内存状态。
 *   2. 通道：在 webServer 上挂 `/api/dsh-sticky-wall/*` 同源 JSON 端点，给 Client 半侧读写。
 *   3. 工具：注册 5 个模型工具 `sticky_wall_*`，让「把这条记到便签墙」直接落到墙上。
 *
 * 说明：这里刻意不 import `@deepseek-ai/*`，只用 Node 内置模块 —— 插件装在 profile 里时
 * 宿主解析第三方包的 ESM 钩子不保证可用，零依赖最稳。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

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

/** 回收站：与墙面同量级（500），只在删除时按条数挤出最旧的，读盘时绝不再裁。超过 30 天自动清掉。 */
const MAX_TRASH = 500
const TRASH_DAYS = 30
const TRASH_TTL_MS = TRASH_DAYS * 24 * 60 * 60 * 1000

const nowMs = () => Date.now()

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
 * 便签已知字段：其余字段原样保留（向前兼容 —— 以后客户端只加字段就不用改宿主）。
 * 危险键（原型链）必须挡掉，否则 HTTP 里塞个 __proto__ 就能污染对象。
 */
const NOTE_FIELDS = new Set([
  'id', 'lines', 'text', 'ruled', 'w', 'minLines', 'color', 'x', 'y', 'pinned', 'z',
  'collapsed', 'trashed', 'deletedAt', 'createdAt', 'updatedAt',
])

/** 取走未知字段（跳过原型链危险键）。 */
function extraFields(src) {
  const extra = {}
  for (const key of Object.keys(src)) {
    if (NOTE_FIELDS.has(key)) continue
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    extra[key] = src[key]
  }
  return extra
}

/**
 * 把外部（HTTP / 工具）传来的字段收敛成一条合法便签。
 * 行是权威数据；只给了 text 就按 Markdown 前缀拆成行，保证老数据与工具写入都能用。
 * @param {unknown} raw 原始输入
 * @param {object|undefined} prev 已存在的同 id 便签（更新时提供，保留 createdAt / 回收站状态）
 */
function normalizeNote(raw, prev) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const now = Date.now()
  const sourceLines = Array.isArray(src.lines)
    ? src.lines.slice(0, MAX_LINES).map(normalizeLine)
    : (typeof src.text === 'string'
        ? linesFromText(src.text.slice(0, MAX_TEXT))
        : (prev?.lines ?? linesFromText(prev?.text ?? '')))
  return Object.assign(extraFields(src), {
    id: typeof src.id === 'string' && src.id !== '' ? src.id.slice(0, 60) : (prev?.id ?? newId()),
    lines: sourceLines,
    text: textFromLines(sourceLines).slice(0, MAX_TEXT),
    ruled: typeof src.ruled === 'boolean' ? src.ruled : (prev?.ruled ?? true),
    collapsed: typeof src.collapsed === 'boolean' ? src.collapsed : (prev?.collapsed ?? false),
    w: Math.round(clampNumber(src.w, MIN_W, MAX_W, prev?.w ?? DEFAULT_W)),
    minLines: Math.round(clampNumber(src.minLines, MIN_LINES, MAX_LINES_H, prev?.minLines ?? DEFAULT_MIN_LINES)),
    color: COLORS.includes(src.color) ? src.color : (prev?.color ?? DEFAULT_COLOR),
    x: clampNumber(src.x, 0, 92, prev?.x ?? 8),
    y: clampNumber(src.y, 0, 88, prev?.y ?? 8),
    pinned: typeof src.pinned === 'boolean' ? src.pinned : (prev?.pinned ?? false),
    z: clampNumber(src.z, 1, 1e9, prev?.z ?? now),
    // 回收站：删除只是打标记，restore 清掉；purge 才真的从数组里拿掉
    trashed: typeof src.trashed === 'boolean' ? src.trashed : (prev?.trashed ?? false),
    deletedAt: typeof src.deletedAt === 'number' ? src.deletedAt : (prev?.deletedAt ?? null),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  })
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

/**
 * 把插件配置里的 `storePath` 解析成绝对路径。
 * 支持：绝对路径 / `~/...` / 相对 `$DSH_HOME` 的路径；空值回落到默认的 `sticky-wall.json`。
 */
function resolveStorePath(raw, home, fallback) {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  let value = raw.trim()
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homedir(), value.slice(1).replace(/^[\\/]+/, ''))
  }
  if (!isAbsolute(value)) value = join(home, value)
  return value
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  // ---- 存储路径（插件配置 storePath 可覆盖；默认 $DSH_HOME/sticky-wall.json）----
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const home = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  const defaultStorePath = join(home, 'sticky-wall.json')
  const storePath = resolveStorePath(cfg.storePath, home, defaultStorePath)

  // 换过路径时，别让老数据凭空消失：新路径还没有文件、而默认文件在，就先搬一份过去
  if (storePath !== defaultStorePath && !existsSync(storePath) && existsSync(defaultStorePath)) {
    try {
      mkdirSync(dirname(storePath), { recursive: true })
      copyFileSync(defaultStorePath, storePath)
      console.log(`[dsh-plugin-sticky-wall] 已把默认数据迁移到 ${storePath}`)
    } catch (error) {
      console.error('[dsh-plugin-sticky-wall] 迁移旧数据失败：', error?.message || String(error))
    }
  }

  /** @type {Array<object>} */
  let notes = []

  function load() {
    try {
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      const list = Array.isArray(raw?.notes) ? raw.notes : []
      // 读盘不截断：截断 = 静默丢数据（写入侧已经限流，这里只做提示，绝不删东西）
      if (list.length > MAX_NOTES + MAX_TRASH) {
        console.warn(`[dsh-plugin-sticky-wall] ${storePath} 里有 ${list.length} 条（上限 ${MAX_NOTES} + 回收站 ${MAX_TRASH}），已全部载入；新增会被拒绝，建议清理回收站`)
      }
      notes = list.map((item) => {
        const n = normalizeNote(item, undefined)
        // 读盘不该刷新 updatedAt：沿用文件里的值，否则每次重启顺序全变
        return {
          ...n,
          createdAt: clampNumber(item?.createdAt, 0, 8.64e15, n.createdAt),
          updatedAt: clampNumber(item?.updatedAt, 0, 8.64e15, n.updatedAt),
        }
      })
      // 回收站：只按保留期清（超过 30 天），不再按条数裁剪 —— 条数在删除时就管住了
      const expired = notes.filter((n) => n.trashed && nowMs() - (n.deletedAt || 0) > TRASH_TTL_MS)
      if (expired.length > 0) {
        notes = notes.filter((n) => !expired.includes(n))
        console.log(`[dsh-plugin-sticky-wall] 清理 ${expired.length} 张超过 ${TRASH_DAYS} 天的回收站便签`)
      }
      return true
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.error(`[dsh-plugin-sticky-wall] 读取 ${storePath} 失败：`, error?.message || String(error))
      }
      return false
    }
  }

  let writeChain = Promise.resolve()
  /** 上一次落盘的内容：一模一样就不写（省一次 1MB 的 tmp+rename）。 */
  let lastPersisted = ''

  /** 原子持久化：写 tmp → rename，写失败只记日志不抛（UI 仍可继续用）。 */
  function persist() {
    const payload = JSON.stringify({ version: 1, notes }, null, 2)
    if (payload === lastPersisted) return writeChain
    lastPersisted = payload
    const tmp = `${storePath}.${process.pid}.tmp`
    writeChain = writeChain
      .then(() => {
        mkdirSync(dirname(storePath), { recursive: true })
        writeFileSync(tmp, payload, 'utf8')
        renameSync(tmp, storePath)
      })
      .catch((error) => {
        try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓 */ }
        // 写失败就把「已落盘内容」作废，下次同样的内容还要再写一次
        lastPersisted = ''
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
   * 上限只数「墙上的」（回收站里的不该占墙面名额）。
   * @returns {{ saved: Array<object>, skipped: number, full: boolean }}
   */
  function upsertMany(inputs) {
    const saved = []
    let skipped = 0
    let full = false
    const wallCount = () => notes.filter((n) => !n.trashed).length
    for (const input of Array.isArray(inputs) ? inputs : []) {
      if (input === null || typeof input !== 'object') { skipped += 1; continue }
      const id = typeof input.id === 'string' ? input.id : ''
      const existing = id === '' ? undefined : notes.find((n) => n.id === id)
      const note = normalizeNote(input, existing)
      if (existing === undefined) {
        const hasText = typeof input.text === 'string' && input.text.trim() !== ''
        // 既没有 id 也没有正文的空壳请求直接丢弃，别在墙上留空白纸
        if (id === '' && !hasText) { skipped += 1; continue }
        if (wallCount() >= MAX_NOTES) { skipped += 1; full = true; continue }
        notes.push(note)
      } else {
        Object.assign(existing, note)
      }
      saved.push(note)
    }
    if (saved.length > 0) persist()
    return { saved, skipped, full }
  }

  /** 回收站超量时挤掉最旧的几张（只在删除动作里调用，并打日志，让「丢」可追溯）。 */
  function trimTrash() {
    const trashed = notes.filter((n) => n.trashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
    if (trashed.length <= MAX_TRASH) return 0
    const drop = new Set(trashed.slice(MAX_TRASH).map((n) => n.id))
    notes = notes.filter((n) => !drop.has(n.id))
    console.log(`[dsh-plugin-sticky-wall] 回收站已满 ${MAX_TRASH} 张，挤掉最旧的 ${drop.size} 张`)
    return drop.size
  }

  function removeNote(id) {
    // 删除 = 打进回收站（软删除），恢复或清空回收站才真的没了
    const note = notes.find((n) => n.id === id && !n.trashed)
    if (note === undefined) return null
    note.trashed = true
    note.deletedAt = nowMs()
    trimTrash()
    persist()
    return note
  }

  function restoreNote(id) {
    const note = notes.find((n) => n.id === id && n.trashed)
    if (note === undefined) return null
    note.trashed = false
    note.deletedAt = null
    // 回到墙面时放到最上层，免得被别的纸压住看不见
    note.z = notes.reduce((max, n) => Math.max(max, n.z || 0), 0) + 1
    persist()
    return note
  }

  function purgeNote(id) {
    const index = notes.findIndex((n) => n.id === id && n.trashed)
    if (index === -1) return false
    notes.splice(index, 1)
    persist()
    return true
  }

  function purgeAllTrash() {
    const count = notes.filter((n) => n.trashed).length
    notes = notes.filter((n) => !n.trashed)
    persist()
    return count
  }

  /** 清空墙面：也是打进回收站，不是直接烧掉。 */
  function clearWall() {
    const now = nowMs()
    let count = 0
    for (const note of notes) {
      if (note.trashed) continue
      note.trashed = true
      note.deletedAt = now
      count += 1
    }
    if (count > 0) {
      trimTrash()
      persist()
    }
    return count
  }

  const wallNotes = () => [...notes].filter((n) => !n.trashed)
  const trashNotes = () => [...notes].filter((n) => n.trashed).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
  const sorted = () => wallNotes().sort((a, b) => (a.z - b.z) || (a.updatedAt - b.updatedAt))

  /**
   * 给 HTTP / 客户端的一致快照：墙上的 + 回收站的 + 存储位置。
   * `withTrash=false` 时只给条数（轮询用）——回收站可能有几百张，没必要每 6 秒全传一遍。
   */
  const snapshotBody = (withTrash = true) => {
    const trash = trashNotes()
    return {
      notes: sorted(),
      trash: withTrash ? trash : [],
      trashCount: trash.length,
      colors: COLORS,
      store: { path: storePath, defaultPath: defaultStorePath, configured: storePath !== defaultStorePath },
    }
  }

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

  /**
   * 同源校验：挡住「本机其它页面」用简单请求（text/plain，不触发预检）偷偷改便签。
   * 浏览器发的请求会带 Sec-Fetch-Site / Origin；非浏览器（脚本、探针）两者都没有，放行。
   * @returns {string} 空串=放行，否则是拒绝原因
   */
  function rejectReason(req) {
    const site = String(req.headers['sec-fetch-site'] || '')
    if (site === 'cross-site' || site === 'same-site') return '拒绝跨站请求'
    const origin = String(req.headers.origin || '')
    if (origin !== '' && origin !== 'null') {
      let host = ''
      try { host = new URL(origin).host } catch { return '来源不合法' }
      if (host !== String(req.headers.host || '')) return '拒绝跨站请求'
    }
    return ''
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = req.url || ''
      const route = url.split('?')[0]
      const action = route.startsWith(API_PREFIX) ? route.slice(API_PREFIX.length) : route
      // ?trash=0 表示「只给回收站条数，不要明细」（客户端轮询用）
      let withTrash = true
      const queryStart = url.indexOf('?')
      if (queryStart !== -1) {
        const params = new URLSearchParams(url.slice(queryStart + 1))
        if (params.get('trash') === '0') withTrash = false
      }
      try {
        const denied = rejectReason(req)
        if (denied !== '') {
          sendJson(res, 403, { ok: false, error: denied })
          return
        }
        if (req.method === 'GET' && (action === '/snapshot' || action === '/')) {
          sendJson(res, 200, Object.assign({ ok: true }, snapshotBody(withTrash)))
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' })
          res.end('method not allowed')
          return
        }
        // 只收 JSON：跨站的简单请求只能用 text/plain / 表单，这一条直接把它们挡在门外
        const contentType = String(req.headers['content-type'] || '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: '只接受 application/json' })
          return
        }

        const body = await readJson(req)

        if (action === '/snapshot') {
          sendJson(res, 200, Object.assign({ ok: true }, snapshotBody(withTrash)))
          return
        }

        if (action === '/upsert') {
          const inputs = Array.isArray(body?.notes) ? body.notes : (body?.note ? [body.note] : [])
          if (inputs.length === 0) {
            sendJson(res, 400, { ok: false, error: '缺少 notes' })
            return
          }
          const result = upsertMany(inputs)
          const head = { ok: true, saved: result.saved.map((n) => n.id), skipped: result.skipped, full: result.full }
          // light：保存回包不带整面墙（客户端每次都传它，500 张时这会多传约 1MB）
          if (body?.light === true) {
            sendJson(res, 200, Object.assign(head, { savedAt: Date.now() }))
            return
          }
          sendJson(res, 200, Object.assign(head, snapshotBody()))
          return
        }

        if (action === '/remove') {
          const note = removeNote(typeof body?.id === 'string' ? body.id : '')
          sendJson(res, note === null ? 404 : 200, note === null
            ? { ok: false, error: '未找到该便签' }
            : Object.assign({ ok: true, trashed: note.id }, snapshotBody()))
          return
        }

        if (action === '/restore') {
          const note = restoreNote(typeof body?.id === 'string' ? body.id : '')
          sendJson(res, note === null ? 404 : 200, note === null
            ? { ok: false, error: '回收站里没有这张便签' }
            : Object.assign({ ok: true, restored: note.id }, snapshotBody()))
          return
        }

        if (action === '/purge') {
          const ok = purgeNote(typeof body?.id === 'string' ? body.id : '')
          sendJson(res, ok ? 200 : 404, ok
            ? Object.assign({ ok: true }, snapshotBody())
            : { ok: false, error: '回收站里没有这张便签' })
          return
        }

        if (action === '/purge-all') {
          const removed = purgeAllTrash()
          sendJson(res, 200, Object.assign({ ok: true, removed }, snapshotBody()))
          return
        }

        if (action === '/clear') {
          const count = clearWall()
          sendJson(res, 200, Object.assign({ ok: true, removed: count }, snapshotBody()))
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
        const { saved, full } = upsertMany([{ text: trimmed, color, pinned, z: maxZ }])
        const note = saved[0]
        if (note === undefined) {
          throw new Error(full
            ? `便签墙已满（${MAX_NOTES} 张），先让用户删几张、或清空到回收站再加`
            : '便签没贴上（请求被丢弃），检查 text 是否为空')
        }
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
        if (existing.trashed === true) throw new Error(`便签 ${id} 在回收站里，先 sticky_wall_restore 再改`)
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
      description: '把便签从墙上拿掉：会移动「回收站」而不是直接销毁，之后可以用 sticky_wall_restore 恢复。',
      presentCall: (args) => ({ card: 'generic', title: `收起便签：${args?.id ?? ''}`, kind: 'delete', rawInput: args }),
      parameters: {
        id: { type: 'string', required: true, description: '便签 id' },
      },
      run: ({ id }) => {
        const note = removeNote(id)
        if (note === null) throw new Error(`未找到便签 ${id}（它可能已经在回收站里）`)
        return `已移到回收站 [${id}]：${oneLine(note.text, 80)}\n（要恢复的话用 sticky_wall_restore，或让用户在右侧抽屉里点「恢复」）`
      },
    }),
    defineTool({
      name: 'sticky_wall_restore',
      description: '把回收站里的一张便签恢复回墙上（恢复后在最上层）。',
      presentCall: (args) => ({ card: 'generic', title: `恢复便签：${args?.id ?? ''}`, kind: 'edit', rawInput: args }),
      parameters: {
        id: { type: 'string', required: true, description: '便签 id' },
      },
      run: ({ id }) => {
        const note = restoreNote(id)
        if (note === null) throw new Error(`回收站里没有 ${id}（可能已经被彻底删掉了）`)
        return `已恢复便签 [${id}]：${oneLine(note.text, 80)}`
      },
    }),
  ]

  ctx.inject(['tools'], (toolCtx) => {
    for (const tool of tools) toolCtx.tools.register(tool)
  })

  console.log(`[dsh-plugin-sticky-wall] 就绪：${storePath}（${notes.length} 条便签）`)
}
