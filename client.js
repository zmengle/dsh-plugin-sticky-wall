window.__ModuleLoader__.load({ id: 'dsh-plugin-sticky-wall', factory: (require) => {
  'use strict'

  // 运行时只依赖 react（平台种子表提供）；不引入任何别的包，也不假设构建步骤。
  const React = require('react')
  const exports = {}

  exports.name = 'dsh-plugin-sticky-wall'

  /** 主面板 key —— 同时也是侧栏 sidebar.panellist 的 id。 */
  const PANEL_ID = 'sticky-wall'
  /** Host 端点前缀。 */
  const API = '/api/dsh-sticky-wall'
  /** 样式标签的归属（模块系统按 data-plugin 回收插件样式）。 */
  const PACKAGE = 'dsh-plugin-sticky-wall'
  const STYLE_ID = 'dsh-plugin-sticky-wall/styles'

  const MAX_TEXT = 4000
  /** 与宿主侧 MAX_NOTES 保持一致：满了就别让对方乐观插入一张永远存不下的纸。 */
  const MAX_NOTES = 500
  /** 纸色：亮纸 + 深墨，浅色/深色主题下都是「桌上的纸」而不是「界面里的卡片」。 */
  const PAPERS = {
    yellow: { label: '黄', bg: '#f6e7a6', ink: '#4a3a0c' },
    mint: { label: '薄荷', bg: '#cfe9d8', ink: '#1c4636' },
    sky: { label: '天蓝', bg: '#cfe1f7', ink: '#173a61' },
    lilac: { label: '淡紫', bg: '#e0d6f7', ink: '#3a2a63' },
    peach: { label: '蜜桃', bg: '#f8d8c3', ink: '#5a3018' },
    rose: { label: '樱粉', bg: '#f6d3de', ink: '#5c2038' },
    sand: { label: '沙', bg: '#eee4d2', ink: '#453723' },
    slate: { label: '石板', bg: '#dfe4ea', ink: '#2b3542' },
  }
  const COLOR_KEYS = Object.keys(PAPERS)

  /**
   * 便签纸几何：这几项必须和 CSS 里的 `.sw-note` / `.sw-lineText` 保持一致 ——
   * NOTE_W 是纸宽（决定新建/整理的网格列数），LINE_H 是行距（横线节奏），
   * PAD_TOP 是正文上内边距（横线整体下移同样的量，字才落在线上）。
   */
  const NOTE_W = 252
  const LINE_H = 22
  const PAD_TOP = 3
  const PAD_BOTTOM = 6
  /** 便签可调的尺寸范围（与 host 侧一致）：宽度 px +「最少几行高」。 */
  const MIN_NOTE_W = 196
  const MAX_NOTE_W = 560
  const DEFAULT_MIN_LINES = 3
  const MAX_MIN_LINES = 30
  /** 便签圆角（纸、顶部压边、缩放手柄共用）。 */
  const RADIUS = 6

  // -------------------------------------------------------------------------
  // 行模型（与 host 半侧同一套规则）
  // -------------------------------------------------------------------------

  /** 行种类：text 正文 / todo 复选框 / ul 无序 / ol 有序。 */
  const KINDS = ['text', 'todo', 'ul', 'ol']
  const MAX_LINE_CHARS = 1000
  const MAX_LINES = 200

  const newLineId = () => 'l-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)

  /** Markdown 写法 → 行种类：贴进来的清单、模型写的内容都能直接成形。 */
  const LINE_PREFIXES = [
    { kind: 'todo', re: /^[-*+]\s*\[([ xX])\]\s?(.*)$/ },
    { kind: 'todo', re: /^\[([ xX])\]\s?(.*)$/ },
    { kind: 'ul', re: /^[-*+]\s+(.*)$/ },
    { kind: 'ol', re: /^\d+[.)]\s+(.*)$/ },
  ]

  /** 输入过程中的「空标记」触发：敲「- 」「- [ ] 」「1. 」就当转换行种类。 */
  const LINE_TRIGGERS = [
    { kind: 'todo', re: /^[-*+]\s*\[\s?\]\s$/ },
    { kind: 'ul', re: /^[-*+]\s$/ },
    { kind: 'ol', re: /^\d+[.)]\s$/ },
  ]

  /**
   * 二级触发：敲「- 」已经先变成无序行了，紧接着再敲「[ ] 」要能升级成待办。
   * （一键转两种格式做不到，所以分两步认。）
   */
  const LINE_TRIGGERS_SECOND = [
    { done: true, re: /^\[[xX]\]\s$/ },
    { done: false, re: /^\[\s?\]\s$/ },
  ]

  function lineFromText(raw) {
    const text = String(raw ?? '')
    for (const rule of LINE_PREFIXES) {
      const match = rule.re.exec(text)
      if (match === null) continue
      if (rule.kind === 'todo') {
        return { id: newLineId(), kind: 'todo', text: match[2].slice(0, MAX_LINE_CHARS), done: match[1].toLowerCase() === 'x' }
      }
      return { id: newLineId(), kind: rule.kind, text: match[1].slice(0, MAX_LINE_CHARS), done: false }
    }
    return { id: newLineId(), kind: 'text', text: text.slice(0, MAX_LINE_CHARS), done: false }
  }

  function linesFromText(text) {
    const source = typeof text === 'string' ? text : ''
    return source.split('\n').slice(0, MAX_LINES).map((line) => lineFromText(line))
  }

  /** 行数组 → 可读正文（给搜索、工具、老数据用）。 */
  function textFromLines(lines) {
    let order = 0
    return (Array.isArray(lines) ? lines : []).map((line) => {
      if (line.kind === 'ol') {
        order += 1
        return order + '. ' + line.text
      }
      order = 0
      if (line.kind === 'todo') return '- [' + (line.done ? 'x' : ' ') + '] ' + line.text
      if (line.kind === 'ul') return '- ' + line.text
      return line.text
    }).join('\n')
  }

  /** 服务端/老数据里的行：补 id、夹长度、兜住不认识的 kind。 */
  function normalizeLine(raw) {
    if (typeof raw === 'string') return lineFromText(raw)
    const src = (raw === null || typeof raw !== 'object') ? {} : raw
    return {
      id: typeof src.id === 'string' && src.id !== '' ? src.id : newLineId(),
      kind: KINDS.includes(src.kind) ? src.kind : 'text',
      text: typeof src.text === 'string' ? src.text.slice(0, MAX_LINE_CHARS) : '',
      done: src.done === true,
    }
  }

  /**
   * 一张便签的行。老数据（只有 text）或还没有行模型的服务端快照会走这里：
   * id 用「便签 id + 行号」这种确定值，保证同一次合并不会把行重新挂载（否则输入焦点会丢）。
   */
  function linesOfNote(note) {
    if (Array.isArray(note.lines) && note.lines.length > 0) return note.lines.map(normalizeLine)
    const base = typeof note.id === 'string' && note.id !== '' ? note.id : 'n'
    const text = typeof note.text === 'string' ? note.text : ''
    const parsed = text.split('\n').slice(0, MAX_LINES).map((piece, index) => {
      const line = lineFromText(piece)
      line.id = base + '-l' + index
      return line
    })
    return parsed.length > 0 ? parsed : [{ id: base + '-l0', kind: 'text', text: '', done: false }]
  }

  /**
   * 服务端 / 老数据的便签 → 本地形状。行只在合并时归一化一次，
   * 之后渲染直接用 note.lines，避免每次 render 生成新 id 把输入框顶掉。
   */
  function normalizeNoteClient(raw) {
    const src = (raw === null || typeof raw !== 'object') ? {} : raw
    const lines = linesOfNote(src)
    return Object.assign({}, src, {
      lines,
      text: typeof src.text === 'string' ? src.text : textFromLines(lines),
      ruled: src.ruled !== false,
    })
  }

  // -------------------------------------------------------------------------
  // 样式
  // -------------------------------------------------------------------------

  const CSS = `
.sw-root{position:relative;display:flex;flex-direction:column;flex:1 1 auto;width:100%;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;contain:layout style}
.sw-head{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sw-brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.sw-title{font-size:15px;font-weight:600;letter-spacing:.25px;white-space:nowrap}
.sw-count{font-size:11px;line-height:1.75;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.sw-spacer{flex:1 1 8px}
.sw-search{position:relative;display:flex;align-items:center}
.sw-search>svg{position:absolute;left:9px;opacity:.42;pointer-events:none}
.sw-search input{width:180px;height:28px;box-sizing:border-box;padding:0 26px 0 28px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:12px;font-family:inherit;letter-spacing:.01em;outline:none;transition:border-color .15s,box-shadow .15s}
.sw-search input::placeholder{color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.sw-search input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.sw-search-clear{position:absolute;right:5px;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border:0;padding:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1}
.sw-search-clear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sw-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;letter-spacing:.01em;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,transform .08s}
.sw-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.sw-btn:active{transform:translateY(1px)}
.sw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sw-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.sw-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.sw-btn--primary:hover{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);filter:brightness(1.08)}
.sw-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.sw-btn--danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:var(--dsw-alias-state-error-primary)}
.sw-btn--trash[aria-pressed="true"]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sw-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.sw-btn:disabled{opacity:.45;cursor:not-allowed}
.sw-btn:disabled:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.sw-wall{position:relative;flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}
.sw-wall:focus{outline:none}
.sw-canvas{position:relative;width:100%;height:100%;min-height:640px;background-image:radial-gradient(circle at 1px 1px,var(--dsw-alias-border-l3) 1px,transparent 0);background-size:26px 26px;background-position:-1px -1px}
/* 便签纸：--sw-lh 是行距，横线按同一节奏画在每行底部；--sw-pad-top 是正文上内边距，
   横线整体下移一行 + 内边距，于是第一条横线就是第一行的下沿（正文上方不留空线）。
   不做旋转：文字在旋转层里会丢掉次像素抗锯齿，看起来发虚；纸的「质感」靠纹理与阴影。 */
.sw-note{--sw-lh:22px;--sw-pad-top:3px;--sw-pad-bottom:6px;--sw-rule:color-mix(in srgb,currentColor 17%,transparent);position:absolute;width:252px;container-type:inline-size;overflow:hidden;display:flex;flex-direction:column;border-radius:8px;box-shadow:0 1px 1px rgba(24,18,8,.13),0 2px 6px rgba(24,18,8,.07),0 10px 22px -10px rgba(24,18,8,.34),inset 0 1px 0 rgba(255,255,255,.45),inset 0 -1px 0 rgba(24,18,8,.06);transition:box-shadow .18s,transform .18s}
.sw-note:hover{transform:translateY(-1px);box-shadow:0 1px 2px rgba(24,18,8,.13),0 3px 8px rgba(24,18,8,.09),0 18px 30px -14px rgba(24,18,8,.38),inset 0 1px 0 rgba(255,255,255,.5),inset 0 -1px 0 rgba(24,18,8,.06)}
.sw-note[data-pinned="true"]::after{content:"";position:absolute;top:0;left:0;right:0;height:3px;border-radius:8px 8px 0 0;background:currentColor;opacity:.3;pointer-events:none}
.sw-note[data-dragging="true"],.sw-note[data-resizing="true"]{transform:scale(1.02);box-shadow:0 8px 14px rgba(24,18,8,.18),0 30px 50px -18px rgba(24,18,8,.5);transition:none}
.sw-note[data-resizing="true"]{transform:none}
.sw-note[data-dragging="true"]{cursor:grabbing}
.sw-note[data-dragging="true"] .sw-noteHead{cursor:grabbing}
.sw-noteHead{display:flex;align-items:center;gap:5px;padding:6px 5px 0 9px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
.sw-grip{display:inline-flex;opacity:.28}
.sw-time{font-size:10px;font-weight:500;opacity:.52;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.sw-progress{flex:none;font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;opacity:.66;border:1px solid color-mix(in srgb,currentColor 26%,transparent);border-radius:999px;padding:0 5px;line-height:1.55}
.sw-noteBtns{margin-left:auto;display:flex;gap:1px}
.sw-iconBtn{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.38;cursor:pointer;transition:opacity .15s,background .15s}
.sw-note:hover .sw-iconBtn{opacity:.82}
.sw-iconBtn:hover{background:rgba(0,0,0,.10);opacity:1}
.sw-iconBtn:focus-visible{outline:2px solid currentColor;outline-offset:1px;opacity:1}
.sw-iconBtn[aria-pressed="true"]{opacity:1;background:rgba(0,0,0,.12)}
/* 正文区：行高 = 横线间距，每行是一个 22px 的行盒，横线的 tile 与之对齐 */
.sw-body{position:relative;padding:var(--sw-pad-top) 14px var(--sw-pad-bottom);min-height:calc(var(--sw-lh) * var(--sw-min-lines,3))}
.sw-note[data-ruled="true"] .sw-body{background-image:linear-gradient(to bottom,var(--sw-rule) 0 1px,transparent 1px);background-size:100% var(--sw-lh);background-repeat:repeat-y;background-position:0 calc(var(--sw-lh) + var(--sw-pad-top))}
.sw-line{display:flex;align-items:flex-start;gap:6px}
.sw-marker{flex:none;width:15px;height:var(--sw-lh);display:flex;align-items:center;justify-content:center}
.sw-check{width:13px;height:13px;margin-top:-1px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:3.5px;border:1.4px solid color-mix(in srgb,currentColor 58%,transparent);background:transparent;color:inherit;cursor:pointer;transition:background .12s,border-color .12s}
.sw-check:hover{border-color:currentColor}
.sw-check:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sw-check[aria-checked="true"]{background:color-mix(in srgb,currentColor 90%,transparent);border-color:transparent}
.sw-check svg{opacity:0;transition:opacity .12s}
.sw-check svg path{stroke:var(--sw-paper,#fff)}
.sw-check[aria-checked="true"] svg{opacity:1}
.sw-bullet{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.6}
.sw-order{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;opacity:.6;letter-spacing:.01em}
.sw-lineText{flex:1;min-width:0;display:block;margin:0;padding:0;border:0;background:transparent;color:inherit;font-family:"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;font-size:14px;line-height:var(--sw-lh);letter-spacing:.012em;font-variant-numeric:tabular-nums;resize:none;overflow:hidden;outline:none;white-space:pre-wrap;word-break:break-word;caret-color:currentColor;height:var(--sw-lh)}
.sw-lineText::placeholder{color:currentColor;opacity:.3;letter-spacing:.02em}
.sw-lineText::selection{background:color-mix(in srgb,currentColor 20%,transparent)}
.sw-line[data-done="true"] .sw-lineText{text-decoration:line-through;text-decoration-thickness:1px;color:color-mix(in srgb,currentColor 52%,transparent)}
.sw-noteFoot{display:flex;align-items:center;gap:6px;height:26px;padding:0 22px 4px 11px;opacity:0;transition:opacity .15s}
.sw-note:hover .sw-noteFoot,.sw-note:focus-within .sw-noteFoot{opacity:1}
.sw-swatches{display:flex;align-items:center;gap:3px}
.sw-swatch{width:10px;height:10px;padding:0;border-radius:50%;border:1px solid rgba(0,0,0,.18);cursor:pointer}
.sw-swatch:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.sw-swatch[aria-pressed="true"]{box-shadow:0 0 0 1.5px color-mix(in srgb,currentColor 82%,transparent)}
.sw-footSep{flex:none;width:1px;height:12px;margin:0 2px;background:color-mix(in srgb,currentColor 20%,transparent)}
.sw-fmt{display:flex;align-items:center;gap:1px;margin-left:auto}
.sw-fmtBtn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;opacity:.55;cursor:pointer;transition:opacity .12s,background .12s}
.sw-fmtBtn:hover{background:rgba(0,0,0,.09);opacity:.95}
.sw-fmtBtn[aria-pressed="true"]{opacity:1;background:rgba(0,0,0,.10)}
.sw-fmtBtn:focus-visible{outline:2px solid currentColor;outline-offset:1px}
/* 右下角缩放：默认隐藏，悬停出现；双击回默认大小 */
.sw-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;display:flex;align-items:flex-end;justify-content:flex-end;padding:0 3px 4px 0;border:0;background:transparent;color:inherit;opacity:0;cursor:nwse-resize;border-bottom-right-radius:8px;transition:opacity .15s}
.sw-note:hover .sw-resize,.sw-note:focus-within .sw-resize{opacity:.35}
.sw-resize:hover{opacity:.85}
.sw-resize:focus-visible{opacity:1;outline:2px solid currentColor;outline-offset:-2px}
/* 窄便签：先收起调色盘，把位置让给行格式按钮（默认宽度 252 时仍显示） */
@container (max-width: 240px){.sw-swatches{display:none}.sw-footSep{display:none}}
/* 折叠：正文只留两行 + 底部渐隐，点一下整张展开；底部菜单此时让位。
   正文不再禁止指针事件 —— 折叠态也能选词，靠 onClick 里判断「是不是在选词」来决定展不展开。 */
.sw-note[data-collapsed="true"] .sw-body{min-height:0;max-height:calc(var(--sw-lh) * 2 + var(--sw-pad-top) + var(--sw-pad-bottom));overflow:hidden;cursor:pointer;-webkit-mask-image:linear-gradient(to bottom,#000 56%,rgba(0,0,0,.1));mask-image:linear-gradient(to bottom,#000 56%,rgba(0,0,0,.1))}
.sw-note[data-collapsed="true"] .sw-lineText{cursor:pointer}
.sw-note[data-collapsed="true"] .sw-noteFoot{display:none}
.sw-collapsedChip{position:absolute;right:24px;bottom:5px;font-size:10px;font-family:inherit;letter-spacing:.04em;line-height:1.5;padding:1px 7px;border:0;border-radius:999px;background:color-mix(in srgb,currentColor 12%,transparent);color:inherit;opacity:.75;cursor:pointer;transition:opacity .12s,background .12s}
.sw-collapsedChip:hover{opacity:.95;background:color-mix(in srgb,currentColor 18%,transparent)}
.sw-collapsedChip:focus-visible{outline:2px solid currentColor;outline-offset:1px}
/* 主区：墙 + 抽屉 + 滚动按钮的定位容器（抽屉只盖住墙，不碰工具栏与页脚） */
.sw-main{position:relative;flex:1 1 auto;min-height:0;display:flex}
/* 层级：便签 ≤ 40000 < 滚动按钮 43000 < 遮罩 44000 < 抽屉 44100 < toast 50000 */
.sw-scroll{position:absolute;right:16px;bottom:16px;z-index:43000;display:flex;flex-direction:column;gap:6px;opacity:0;pointer-events:none;transition:opacity .15s}
.sw-scroll[data-visible="true"]{opacity:1;pointer-events:auto}
.sw-scrollBtn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.16);transition:border-color .15s,opacity .15s}
.sw-scrollBtn:hover{border-color:var(--dsw-alias-border-l3)}
.sw-scrollBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sw-scrollBtn:disabled{opacity:.28;cursor:default}
/* 回收站抽屉：右侧滑入，悬浮在墙上方，不挤压布局；窄面板下最多占墙宽 - 56px */
.sw-trash{position:absolute;top:0;right:0;bottom:0;left:0;z-index:44100;display:flex;align-items:stretch;justify-content:flex-end;pointer-events:none}
.sw-trashScrim{position:absolute;inset:0;z-index:44000;background:transparent}
.sw-trashPanel{pointer-events:auto;width:min(300px,calc(100% - 56px));margin:10px 10px 10px 0;display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 40px -14px rgba(0,0,0,.4);overflow:hidden;animation:sw-trash-in .16s ease-out}
@keyframes sw-trash-in{from{transform:translateX(14px);opacity:.35}to{transform:none;opacity:1}}
.sw-trashHead{flex:none;display:flex;align-items:center;gap:8px;padding:9px 8px 8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sw-trashTitle{font-size:13px;font-weight:600;letter-spacing:.02em}
.sw-trashMeta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sw-trashList{flex:1 1 auto;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.sw-trashEmpty{padding:24px 16px;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.sw-trashItem{display:flex;align-items:stretch;gap:8px;padding:8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.sw-trashSwatch{flex:none;width:7px;border-radius:3px}
.sw-trashMain{flex:1 1 auto;min-width:0}
.sw-trashText{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.sw-trashWhen{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:3px;font-variant-numeric:tabular-nums}
.sw-trashActions{display:flex;flex-direction:column;justify-content:center;gap:4px}
.sw-miniBtn{height:22px;padding:0 8px;font-size:11px;font-family:inherit;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.sw-miniBtn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}
.sw-miniBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sw-miniBtn--danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.sw-miniBtn--danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:var(--dsw-alias-state-error-primary)}
.sw-trashFoot{flex:none;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.sw-trashFoot .sw-btn{width:100%;justify-content:center;height:28px}
.sw-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px;pointer-events:none}
.sw-empty>svg{opacity:.28}
.sw-empty-title{font-size:14.5px;font-weight:600;letter-spacing:.02em}
.sw-empty-desc{font-size:12px;color:var(--dsw-alias-label-secondary);max-width:310px;line-height:1.75;letter-spacing:.01em}
.sw-empty .sw-btn{pointer-events:auto;height:30px}
.sw-foot{flex:none;display:flex;align-items:center;gap:10px;padding:7px 18px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;letter-spacing:.01em;color:var(--dsw-alias-label-secondary)}
.sw-foot-tip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-foot .sw-spacer{flex:1 1 8px}
.sw-path{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;letter-spacing:.01em;cursor:pointer;border-radius:5px}
.sw-path:hover{color:var(--dsw-alias-label-primary);text-decoration:underline dotted}
.sw-path:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sw-path[data-configured="true"]{color:var(--dsw-alias-brand-primary)}
.sw-status{white-space:nowrap;font-variant-numeric:tabular-nums}
.sw-status--error{color:var(--dsw-alias-state-error-primary);background:none;border:0;padding:0;font:inherit;cursor:pointer;text-decoration:underline dotted}
/* 提示条：底部居中竖排，最多 3 条；新提示不顶掉旧的（尤其是带「撤销」的那条） */
.sw-toasts{position:absolute;left:50%;bottom:48px;transform:translateX(-50%);z-index:50000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;max-width:calc(100% - 40px)}
.sw-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:min(520px,100%);padding:8px 12px 8px 15px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;letter-spacing:.01em;box-shadow:0 8px 24px rgba(0,0,0,.25);white-space:pre-wrap}
.sw-toastText{flex:1 1 auto;min-width:0}
.sw-toastAction{flex:none;height:24px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-size:12px;font-family:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.sw-toastAction:hover{border-color:var(--dsw-alias-brand-primary)}
.sw-toastAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.sw-toast[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
@media (prefers-reduced-motion:reduce){.sw-note,.sw-btn,.sw-swatches,.sw-iconBtn{transition:none}}
@media (max-width:640px){.sw-head{padding:10px 12px}.sw-search input{width:120px}.sw-foot{padding:6px 12px}}
`

  function installStyles() {
    if (typeof document === 'undefined') return
    const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
    if (existing !== null) {
      // 热替换时旧标签可能还在：内容变了就直接改写，别让新样式被幂等判断挡掉
      existing.dataset.plugin = PACKAGE
      if (existing.textContent !== CSS) existing.textContent = CSS
      return
    }
    const tag = document.createElement('style')
    tag.dataset.plugin = PACKAGE
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // -------------------------------------------------------------------------
  // 小工具
  // -------------------------------------------------------------------------

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))
  const round1 = (value) => Math.round(value * 10) / 10

  function relTime(ms) {
    const delta = Date.now() - (Number.isFinite(ms) ? ms : Date.now())
    if (delta < 60_000) return '刚刚'
    if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前'
    if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前'
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function clockOf(ms) {
    const d = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  /** 存储路径只显示最后两段（完整路径放 title 里），避免把页脚撑开。 */
  function shortPath(path) {
    if (typeof path !== 'string' || path === '') return ''
    const parts = path.split(/[\\/]+/).filter((part) => part !== '')
    return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/')
  }

  /** 复制存储路径：优先用剪贴板 API，失败就退回选中文本提示。 */
  async function copyStorePath(path) {
    try {
      await navigator.clipboard.writeText(path)
      notify('已复制存储路径', 'ok')
    } catch {
      notify('复制失败，路径是：' + path, 'error')
    }
  }

  // -------------------------------------------------------------------------
  // Host RPC
  // -------------------------------------------------------------------------

  async function rpc(action, body) {
    const response = await fetch(API + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    })
    const text = await response.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('服务响应异常（HTTP ' + response.status + '）')
    }
    if (data === null || typeof data !== 'object') throw new Error('服务响应异常')
    if (data.ok === false) throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'))
    return data
  }

  // -------------------------------------------------------------------------
  // 极简 store（闭包内，组件间共享）
  // -------------------------------------------------------------------------

  /** 回收站抽屉的偏好（固定与否）记在本地，不占便签数据。 */
  const TRASH_PREF_KEY = 'dsh-sticky-wall:trash'
  function readTrashPref() {
    try {
      const raw = localStorage.getItem(TRASH_PREF_KEY)
      if (raw === null) return { pinned: false }
      const parsed = JSON.parse(raw)
      return { pinned: parsed !== null && typeof parsed === 'object' && parsed.pinned === true }
    } catch {
      return { pinned: false }
    }
  }
  function saveTrashPref(pinned) {
    try { localStorage.setItem(TRASH_PREF_KEY, JSON.stringify({ pinned })) } catch { /* 隐私模式下写不了，忽略 */ }
  }
  const trashPref = readTrashPref()

  let state = {
    notes: [],
    trash: [],
    trashTotal: 0, // 服务端的回收站条数（我们手里这份明细对应它）
    store: null, // { path, defaultPath, configured } —— 数据文件位置（可在插件配置里改）
    status: 'loading', // loading | ready | error
    error: '',
    query: '',
    pinnedOnly: false,
    focusId: null,
    dragId: null,
    saving: 0,
    savedAt: 0,
    confirmClear: false,
    confirmPurge: false,
    trashOpen: trashPref.pinned,
    trashPinned: trashPref.pinned,
    toasts: [], // [{ id, text, kind, action? }] —— 最多 3 条，互不顶掉
  }
  const subscribers = new Set()
  const getSnapshot = () => state
  function subscribe(listener) {
    subscribers.add(listener)
    return () => subscribers.delete(listener)
  }
  function setState(patch) {
    state = Object.assign({}, state, patch)
    for (const listener of subscribers) listener()
  }
  function useWall() {
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  /**
   * 提示条：最多同时 3 条，各自到点自己消失。
   * 以前只有一条，「删除 → 撤销」会被后一条提示顶掉，所以改成小队列。
   */
  let toastSeq = 0
  function dismissToast(id) {
    if (!state.toasts.some((item) => item.id === id)) return
    setState({ toasts: state.toasts.filter((item) => item.id !== id) })
  }
  function notify(text, kind, action) {
    const toast = { id: ++toastSeq, text: String(text), kind: kind || 'info', action: action || null }
    setState({ toasts: state.toasts.concat([toast]).slice(-3) })
    setTimeout(() => dismissToast(toast.id), action ? 6000 : 4200)
  }

  /** 已进入保存流程、还没被服务端确认的 id —— 轮询合并时优先信本地。 */
  const dirty = new Set()
  const saveTimers = new Map()
  /** 每张便签的本地修改序号：用来判断「保存回包期间用户又改了」，避免旧快照盖掉新改动。 */
  const revisions = new Map()

  const byZ = (a, b) => (a.z - b.z) || (a.updatedAt - b.updatedAt)
  const maxZ = () => state.notes.reduce((max, n) => Math.max(max, n.z || 0), 0)

  /** 服务端快照合并：dirty / 正在拖的便签保留本地版本，其余采纳服务端。 */
  function mergeRemote(remote) {
    const incoming = new Map()
    for (const note of Array.isArray(remote) ? remote : []) {
      if (!note || typeof note.id !== 'string') continue
      const normalized = normalizeNoteClient(note)
      if (!Array.isArray(note.lines)) {
        // 兼容旧宿主（只回 text）：文本没变就沿用本地的行，别让行 id 变化把输入焦点顶掉
        const local = state.notes.find((item) => item.id === normalized.id)
        if (local !== undefined && local.text === normalized.text && Array.isArray(local.lines)) {
          normalized.lines = local.lines
        }
      }
      incoming.set(note.id, normalized)
    }
    const next = []
    for (const local of state.notes) {
      if (dirty.has(local.id) || state.dragId === local.id) {
        next.push(local)
        incoming.delete(local.id)
        continue
      }
      const fresh = incoming.get(local.id)
      if (fresh !== undefined) {
        next.push(fresh)
        incoming.delete(local.id)
      }
    }
    for (const rest of incoming.values()) next.push(rest)
    next.sort(byZ)
    setState({ notes: next })
  }

  /** 回收站快照：服务端是权威，直接整表替换（同时记下「服务端条数」= 我们这份是对的）。 */
  function mergeTrash(remote) {
    const list = (Array.isArray(remote) ? remote : [])
      .filter((note) => note !== null && typeof note === 'object' && typeof note.id === 'string')
      .map(normalizeNoteClient)
    setState({ trash: list, trashTotal: list.length })
  }

  /**
   * @param {boolean} quiet 静默（轮询时不要弹错误提示）
   * @param {boolean} withTrash 是否要回收站明细；轮询传 false，只比条数，变了再补拉一次
   */
  async function load(quiet, withTrash = true) {
    try {
      const data = await rpc('/snapshot' + (withTrash ? '' : '?trash=0'))
      mergeRemote(data.notes)
      if (withTrash) {
        mergeTrash(Array.isArray(data.trash) ? data.trash : [])
      } else if (typeof data.trashCount === 'number' && data.trashCount !== state.trashTotal) {
        // 回收站变了（比如模型刚删了一张）：补拉一次明细
        load(true, true)
      }
      if (data.store !== null && typeof data.store === 'object') {
        setState({ store: data.store })
        // 数据文件坏了、宿主已把原文件备份：必须告诉用户，不然他会以为便签凭空消失
        if (typeof data.store.backup === 'string' && data.store.backup !== '' && !warnedBackup) {
          warnedBackup = true
          notify('数据文件损坏，原文件已备份为 ' + shortPath(data.store.backup) + '（可以手动抢救）', 'error')
        }
      }
      setState({ status: 'ready', error: '' })
    } catch (error) {
      setState({ status: 'error', error: String(error?.message || error) })
      if (!quiet) notify('读取便签墙失败：' + String(error?.message || error), 'error')
    }
  }

  const serialize = (note) => ({
    id: note.id,
    text: typeof note.text === 'string' ? note.text.slice(0, MAX_TEXT) : '',
    lines: Array.isArray(note.lines) ? note.lines : undefined,
    ruled: note.ruled !== false,
    collapsed: note.collapsed === true,
    w: typeof note.w === 'number' ? note.w : NOTE_W,
    minLines: typeof note.minLines === 'number' ? note.minLines : DEFAULT_MIN_LINES,
    color: note.color,
    x: note.x,
    y: note.y,
    pinned: Boolean(note.pinned),
    z: note.z,
  })

  function queueSave(id, delay) {
    dirty.add(id)
    const timer = saveTimers.get(id)
    if (timer) clearTimeout(timer)
    saveTimers.set(id, setTimeout(() => {
      saveTimers.delete(id)
      flush(id)
    }, delay === undefined ? 650 : delay))
  }

  async function flush(id) {
    const note = state.notes.find((n) => n.id === id)
    if (note === undefined) {
      dirty.delete(id)
      return
    }
    const sentRevision = revisions.get(id) || 0
    setState({ saving: state.saving + 1 })
    try {
      // light：保存回包不用带整面墙（500 张时要多传 1MB），本地就是权威
      const data = await rpc('/upsert', { notes: [serialize(note)], light: true })
      // 回包期间用户又改了这一张：保留本地改动（dirty 不清），让后面的定时保存再发一次
      if ((revisions.get(id) || 0) === sentRevision) dirty.delete(id)
      if (Array.isArray(data.notes)) mergeRemote(data.notes)
      setState({ status: 'ready', error: '', savedAt: Date.now(), saving: Math.max(0, state.saving - 1) })
    } catch (error) {
      setState({
        status: 'error',
        error: String(error?.message || error),
        saving: Math.max(0, state.saving - 1),
      })
      notify('保存失败：' + String(error?.message || error), 'error')
    }
  }

  function queueSaveAll() {
    for (const id of Array.from(dirty)) queueSave(id, 0)
  }

  function updateNote(id, patch, opts) {
    const notes = state.notes.map((note) => (
      note.id === id ? Object.assign({}, note, patch, { updatedAt: Date.now() }) : note
    ))
    revisions.set(id, (revisions.get(id) || 0) + 1)
    setState({ notes })
    if (!opts || opts.save !== false) queueSave(id, opts?.delay)
  }

  /** 墙上最宽的那张纸：新建/整理的网格按它算，免得宽纸被后来的纸压住。 */
  const widestNote = () => state.notes.reduce((max, note) => Math.max(max, note.w || NOTE_W), NOTE_W)

  /** 找一个空位：按当前画布宽度算列数，优先填没被占的格子。 */
  function freeSlot(canvas) {
    const width = Math.max(360, (canvas === null || canvas === undefined) ? 900 : canvas.clientWidth)
    const notePct = (widestNote() / width) * 100
    const cellX = Math.min(34, notePct + 2.5)
    const columns = Math.max(1, Math.floor(96 / cellX))
    for (let index = 0; index < columns * 3; index++) {
      const x = round1(2 + (index % columns) * cellX)
      const y = round1(3 + Math.floor(index / columns) * 30)
      const hit = state.notes.some((note) => Math.abs(note.x - x) < cellX * 0.55 && Math.abs(note.y - y) < 24)
      if (!hit) return { x, y }
    }
    const fallback = state.notes.length
    return {
      x: round1(2 + (fallback % columns) * cellX),
      y: round1(3 + (fallback % 3) * 30),
    }
  }

  function createNote(anchor, canvas) {
    if (state.notes.length >= MAX_NOTES) {
      notify('便签墙满了（' + MAX_NOTES + ' 张），先删几张或清到回收站再加', 'error')
      return null
    }
    const z = maxZ() + 1
    const spot = anchor || freeSlot(canvas)
    const x = spot.x
    const y = spot.y
    const color = COLOR_KEYS[state.notes.length % COLOR_KEYS.length]
    const now = Date.now()
    const firstLine = { id: newLineId(), kind: 'text', text: '', done: false }
    const note = {
      id: 'n-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      lines: [firstLine],
      text: '',
      ruled: true,
      w: NOTE_W,
      minLines: DEFAULT_MIN_LINES,
      color,
      x: round1(clamp(x, 0, 92)),
      y: round1(clamp(y, 0, 88)),
      pinned: false,
      z,
      createdAt: now,
      updatedAt: now,
    }
    setState({ notes: state.notes.concat([note]).sort(byZ), focusId: firstLine.id })
    queueSave(note.id, 0)
    return note
  }

  /** 当前墙的滚动容器：删除后把焦点收回这里，键盘用户不会「掉到页面顶部」。 */
  let wallEl = null
  /** 坏文件备份的提示只弹一次（轮询会反复带这个字段）。 */
  let warnedBackup = false

  /** 删除 = 进回收站（软删除）。乐观更新 + toast 里给一个「撤销」。 */
  async function removeNote(id) {
    const backup = state.notes
    const pending = saveTimers.get(id)
    if (pending) { clearTimeout(pending); saveTimers.delete(id) }
    dirty.delete(id)
    setState({ notes: state.notes.filter((note) => note.id !== id) })
    // 焦点原来在被删的那张上：等 DOM 提交后收回到墙面（不移动光标、不动滚动）
    requestAnimationFrame(() => {
      if (wallEl === null) return
      try { wallEl.focus({ preventScroll: true }) } catch { /* 老浏览器忽略参数 */ try { wallEl.focus() } catch { /* 忽略 */ } }
    })
    try {
      const data = await rpc('/remove', { id })
      mergeRemote(data.notes)
      if (Array.isArray(data.trash)) mergeTrash(data.trash)
      notify('已移到回收站（右侧抽屉）', 'ok', { label: '撤销', run: () => { restoreNote(id) } })
    } catch (error) {
      setState({ notes: backup })
      notify('删除失败：' + String(error?.message || error), 'error')
    }
  }

  /**
   * 恢复回来的纸如果正好压在别人身上（重叠超过自身面积 20%），挪到第一个空位。
   * 位置是按百分比存的，宿主不知道像素尺寸，所以这一步只能在客户端做。
   */
  function settleRestored(id) {
    requestAnimationFrame(() => {
      const canvas = wallEl === null ? null : wallEl.querySelector('.sw-canvas')
      if (canvas === null) return
      const el = canvas.querySelector('[data-note-id="' + id + '"]')
      if (el === null) return
      const mine = el.getBoundingClientRect()
      const area = Math.max(1, mine.width * mine.height)
      let worst = 0
      for (const other of canvas.querySelectorAll('.sw-note')) {
        if (other === el) continue
        const rect = other.getBoundingClientRect()
        const w = Math.min(mine.right, rect.right) - Math.max(mine.left, rect.left)
        const h = Math.min(mine.bottom, rect.bottom) - Math.max(mine.top, rect.top)
        if (w > 0 && h > 0) worst = Math.max(worst, (w * h) / area)
      }
      if (worst < 0.2) return
      const spot = freeSlot(canvas)
      updateNote(id, { x: spot.x, y: spot.y })
      notify('原位置被占，已挪到空格子', 'ok')
    })
  }

  async function restoreNote(id) {
    try {
      const data = await rpc('/restore', { id })
      mergeRemote(data.notes)
      if (Array.isArray(data.trash)) mergeTrash(data.trash)
      notify('已恢复一张便签', 'ok')
      settleRestored(id)
    } catch (error) {
      notify('恢复失败：' + String(error?.message || error), 'error')
    }
  }

  async function purgeNote(id) {
    try {
      const data = await rpc('/purge', { id })
      mergeRemote(data.notes)
      if (Array.isArray(data.trash)) mergeTrash(data.trash)
      notify('已彻底删除', 'ok')
    } catch (error) {
      notify('删除失败：' + String(error?.message || error), 'error')
    }
  }

  async function purgeAllTrash() {
    try {
      const data = await rpc('/purge-all', {})
      mergeRemote(data.notes)
      if (Array.isArray(data.trash)) mergeTrash(data.trash)
      setState({ confirmPurge: false })
      notify('回收站已清空', 'ok')
    } catch (error) {
      notify('清空回收站失败：' + String(error?.message || error), 'error')
    }
  }

  async function clearAll() {
    try {
      // 清空墙面同样是软删除：全部进回收站，后悔还能捞回来
      const data = await rpc('/clear')
      dirty.clear()
      for (const timer of saveTimers.values()) clearTimeout(timer)
      saveTimers.clear()
      mergeRemote(data.notes)
      if (Array.isArray(data.trash)) mergeTrash(data.trash)
      setState({ confirmClear: false, savedAt: Date.now() })
      notify('已清空到回收站', 'ok')
    } catch (error) {
      notify('清空失败：' + String(error?.message || error), 'error')
    }
  }

  function toggleTrash() {
    const open = !state.trashOpen
    setState({ trashOpen: open })
    // 打开抽屉时如果手里的明细和服务端条数对不上，先补一次
    if (open && state.trashTotal !== state.trash.length) load(true, true)
  }

  function toggleTrashPin() {
    const pinned = !state.trashPinned
    saveTrashPref(pinned)
    setState({ trashPinned: pinned, trashOpen: pinned ? true : state.trashOpen })
  }

  function raise(id) {
    const note = state.notes.find((n) => n.id === id)
    if (note === undefined) return
    const z = maxZ() + 1
    if (note.z === z) return
    updateNote(id, { z }, { delay: 900 })
  }

  /**
   * 整理 = 对齐，不是重排。
   *
   * 规则（按「你摆的行」为准，不重新洗牌）：
   *   1. 按现在的位置把便签聚成行（y 相差 56px 以内算同一行）；
   *   2. 行内保持你摆的左右顺序，统一左对齐，间距 16px；
   *   3. 行与行之间按「这一行最高的一张 + 16px」往下排，整体左边距 18px；
   *   4. 某一行真的比面板还宽时，先把行内间距从 16px 压到 8px；还是放不下，
   *      才把这一行末尾的几张挪到下一行（这时才会出现「换行」，而不是因为它是宽纸就单独甩出去）。
   * 换句话说：整理只让边缘和间距变整齐，不会因为某张纸大就把它排到后面去。
   */
  function arrange(canvas) {
    if (state.notes.length === 0) return
    const width = Math.max(360, (canvas === null || canvas === undefined) ? 900 : canvas.clientWidth)
    const wallHeight = Math.max(360, (canvas === null || canvas === undefined) ? 640 : canvas.clientHeight)
    // 每次重排都先解除上次撑出来的高度，再按实际内容决定要不要长高
    if (canvas !== null && canvas !== undefined) canvas.style.minHeight = ''
    const GAP = 16
    const MIN_GAP = 8
    const MARGIN = 18
    const ROW_TOLERANCE = 56
    const usable = Math.max(200, width - MARGIN * 2)

    /** 量真实尺寸：DOM 里量最准；被搜索过滤掉的纸用行数估。 */
    function measure(note) {
      const el = document.querySelector('.sw-note[data-note-id="' + note.id + '"]')
      if (el !== null) return { w: el.offsetWidth, h: el.offsetHeight }
      const lineCount = Array.isArray(note.lines) ? note.lines.length : 1
      const minLines = typeof note.minLines === 'number' ? note.minLines : DEFAULT_MIN_LINES
      return {
        w: typeof note.w === 'number' ? note.w : NOTE_W,
        h: 26 + Math.max(minLines, lineCount) * LINE_H + PAD_TOP + PAD_BOTTOM + 24,
      }
    }

    // ---- 1. 按现有 y 聚成行（不改变行归属）----
    const ordered = state.notes.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x) || byZ(a, b))
    const rows = []
    for (const note of ordered) {
      const size = measure(note)
      const item = { note, w: Math.min(size.w, usable), h: size.h, x: note.x, yPx: (note.y / 100) * wallHeight }
      const last = rows[rows.length - 1]
      if (last !== undefined && Math.abs(item.yPx - last.yPx) <= ROW_TOLERANCE) last.items.push(item)
      else rows.push({ yPx: item.yPx, items: [item] })
    }
    // ---- 2. 行内按你摆的左右顺序（x 从小到大）----
    for (const row of rows) row.items.sort((a, b) => a.x - b.x)

    // ---- 3. 落位：行内左对齐 + 统一间距；太宽就先压间距，实在不行才把尾部挪到下一行 ----
    const lines = []
    let cursorY = MARGIN
    for (const row of rows) {
      let queue = row.items.slice()
      while (queue.length > 0) {
        const line = []
        let used = 0
        for (const item of queue) {
          const next = used + (line.length === 0 ? 0 : GAP) + item.w
          if (line.length === 0 || next <= usable) {
            line.push(item)
            used = next
          } else break
        }
        // 差一点点放不下时，把这一行的间距压到 MIN_GAP 再试一次
        if (line.length > 0 && line.length < queue.length) {
          const extra = queue[line.length]
          const totalW = line.reduce((sum, item) => sum + item.w, 0) + extra.w
          const tight = (usable - totalW) / line.length
          if (tight >= MIN_GAP) line.push(extra)
        }
        const h = line.reduce((max, item) => Math.max(max, item.h), 0)
        lines.push({ items: line, y: cursorY, h })
        cursorY += h + GAP
        queue = queue.slice(line.length)
      }
    }
    const contentBottom = Math.max(0, cursorY - GAP)

    // ---- 4. 内容比画布高时把画布撑高；除以 0.84 保证最后一行的 y% 不顶到主机侧 88% 上限 ----
    const height = Math.max(wallHeight, contentBottom / 0.84)
    if (canvas !== null && canvas !== undefined && height > wallHeight) {
      canvas.style.minHeight = Math.ceil(height) + 'px'
    }

    const layout = []
    for (const line of lines) {
      const sumW = line.items.reduce((sum, item) => sum + item.w, 0)
      const gaps = Math.max(1, line.items.length - 1)
      const gap = line.items.length > 1
        ? Math.min(GAP, Math.max(MIN_GAP, Math.floor((usable - sumW) / gaps)))
        : GAP
      let x = MARGIN
      for (const item of line.items) {
        layout.push({ note: item.note, x, y: line.y })
        x += item.w + gap
      }
    }

    const notes = layout.map(({ note, x, y }) => Object.assign({}, note, {
      x: round1(clamp(x / width * 100, 0, 92)),
      y: round1(clamp(y / height * 100, 0, 88)),
      updatedAt: Date.now(),
    }))
    setState({ notes })
    for (const note of notes) queueSave(note.id, 0)
    notify('已对齐 ' + notes.length + ' 张便签', 'ok')
  }

  // -------------------------------------------------------------------------
  // 图标
  // -------------------------------------------------------------------------

  /**
   * 统一图标：24 网格、圆头圆角。描边按尺寸取 —— 小图标 2（12px 时正好 1px 实心线），
   * 大图标 1.6，避免放大后显得笨重。所有图标共用这一套，视觉重量才一致。
   */
  function Icon({ size = 14, children, viewBox = '0 0 24 24' }) {
    return React.createElement('svg', {
      width: size,
      height: size,
      viewBox,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: size >= 24 ? 1.6 : 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    }, children)
  }

  /** 图钉：钉子 + 帽 */
  const pinPath = React.createElement(React.Fragment, null,
    React.createElement('path', { d: 'M9.5 3.6h5l-.6 5.4 3.4 3.2v1.9H6.7v-1.9l3.4-3.2-.6-5.4Z' }),
    React.createElement('path', { d: 'M12 14.1V20.6' }))
  /** 垃圾桶：只留外轮廓，12px 才不糊 */
  const trashPath = React.createElement('path', {
    d: 'M4 6.6h16 M9.4 6.6V4.1h5.2v2.5 M6.6 6.6l.8 13.2h9.2l.8-13.2',
  })
  const plusPath = React.createElement('path', { d: 'M12 4.8v14.4 M4.8 12h14.4' })
  const gridPath = React.createElement(React.Fragment, null,
    React.createElement('rect', { x: 3.8, y: 3.8, width: 7, height: 7, rx: 2 }),
    React.createElement('rect', { x: 13.2, y: 3.8, width: 7, height: 7, rx: 2 }),
    React.createElement('rect', { x: 3.8, y: 13.2, width: 7, height: 7, rx: 2 }),
    React.createElement('rect', { x: 13.2, y: 13.2, width: 7, height: 7, rx: 2 }))
  const searchPath = React.createElement(React.Fragment, null,
    React.createElement('circle', { cx: 11, cy: 11, r: 6.6 }),
    React.createElement('path', { d: 'M15.8 15.8 21 21' }))
  const gripPath = React.createElement(React.Fragment, null,
    React.createElement('circle', { cx: 9, cy: 6.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 15, cy: 6.4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 9, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 15, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 9, cy: 17.6, r: 1.5, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 15, cy: 17.6, r: 1.5, fill: 'currentColor', stroke: 'none' }))
  const closePath = React.createElement('path', { d: 'M6 6 18 18 M18 6 6 18' })
  /** 收起 / 展开：一个朝下、一个朝上 */
  const collapsePath = React.createElement('path', { d: 'M6 9.5 12 15.5 18 9.5' })
  const expandPath = React.createElement('path', { d: 'M6 14.5 12 8.5 18 14.5' })

  /** 侧栏图标：一张贴着的便签（currentColor，跟随选中态）。 */
  function SidebarIcon({ size = 16 }) {
    return React.createElement('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': true,
      focusable: false,
    },
      React.createElement('path', {
        d: 'M4.5 3.5h15v12.5l-4.5 4.5H4.5z',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinejoin: 'round',
        fill: 'currentColor',
        fillOpacity: 0.12,
      }),
      React.createElement('path', {
        d: 'M15 20.5V16h4.5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinejoin: 'round',
      }),
      React.createElement('path', {
        d: 'M8 8.5h8 M8 12h5',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
      }),
      React.createElement('circle', { cx: 12, cy: 4.6, r: 1.5, fill: 'currentColor' }))
  }

  // -------------------------------------------------------------------------
  // 便签
  // -------------------------------------------------------------------------

  /** 纸面纹理：细颗粒（SVG 噪声）+ 左上角柔光 + 下沿压暗，替代旋转——旋转层里的文字会丢次像素抗锯齿，看着发虚。 */
  const PAPER_GRAIN = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'><filter id=\'g\'><feTurbulence type=\'fractalNoise\' baseFrequency=\'1.05\' numOctaves=\'2\' stitchTiles=\'stitch\'/><feColorMatrix type=\'saturate\' values=\'0\'/></filter><rect width=\'120\' height=\'120\' filter=\'url(%23g)\' opacity=\'0.09\'/></svg>")'

  const PAPER_STYLE = {
    backgroundImage: 'radial-gradient(120% 90% at 16% -12%, rgba(255,255,255,.42), rgba(255,255,255,0) 58%),'
      + 'linear-gradient(to bottom, rgba(255,255,255,0) 64%, rgba(24,18,8,.05) 100%),'
      + PAPER_GRAIN,
    backgroundSize: '100% 100%, 100% 100%, 120px 120px',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    backgroundPosition: '0 0, 0 0, 0 0',
  }

  /** 行格式按钮（作用在「当前行」上）。图标是路径，不是文字字形 —— 重量与对齐才统一。 */
  const FORMATS = [
    {
      kind: 'text',
      label: '正文',
      icon: React.createElement('path', { d: 'M4 6.5h16 M4 12h16 M4 17.5h10' }),
    },
    {
      kind: 'todo',
      label: '待办：点方框打勾',
      icon: React.createElement(React.Fragment, null,
        React.createElement('rect', { x: 3.6, y: 3.6, width: 16.8, height: 16.8, rx: 5 }),
        React.createElement('path', { d: 'M8 12.2 10.8 15 16.2 9.2' })),
    },
    {
      kind: 'ul',
      label: '无序列表',
      icon: React.createElement(React.Fragment, null,
        React.createElement('circle', { cx: 5, cy: 6.5, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 5, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: 5, cy: 17.5, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        React.createElement('path', { d: 'M9.5 6.5h10.5 M9.5 12h10.5 M9.5 17.5h10.5' })),
    },
    {
      kind: 'ol',
      label: '有序列表',
      icon: React.createElement(React.Fragment, null,
        React.createElement('path', { d: 'M10 6.5h10 M10 12h10 M10 17.5h10' }),
        React.createElement('path', { d: 'M4.4 10V3.9' }),
        React.createElement('path', { d: 'M4.4 4.7 5.8 3.7' }),
        React.createElement('path', { d: 'M3.4 10h2.2' })),
    },
  ]

  /** 横线纸开关的图标：一张带横线的纸（和底部的行格式按钮区分开）。 */
  const ruledPath = React.createElement(React.Fragment, null,
    React.createElement('rect', { x: 3.5, y: 4, width: 17, height: 16, rx: 3 }),
    React.createElement('path', { d: 'M7.2 9.2h9.6 M7.2 14.4h6.4' }))

  /** 右下角缩放手柄：两道斜线。 */
  const resizePath = React.createElement('path', { d: 'M20 9.5 9.5 20 M20 15.5 15.5 20' })

  /** 立即把焦点放到某一行。只在 DOM 已经提交后调用（useLayoutEffect 里），不用定时器。 */
  function applyFocus(id, caret) {
    const el = document.getElementById('swl-' + id)
    if (el === null) return false
    el.focus()
    const pos = caret === 'start' ? 0 : (typeof caret === 'number' ? caret : el.value.length)
    try { el.setSelectionRange(pos, pos) } catch { /* 某些环境不允许 setSelectionRange，忽略 */ }
    return true
  }

  /** 一行：标记（复选框 / 圆点 / 序号）+ 自动增高的输入框。collapsed 时只读，便于选词不误改。 */
  function NoteLine({ line, number, placeholder, collapsed, onToggle, onChange, onKeyDown, onPaste, onFocus }) {
    const ref = React.useRef(null)

    // 单行/折行都按整行增高，横线才不会被切半行
    React.useLayoutEffect(() => {
      const el = ref.current
      if (el === null) return
      el.style.height = 'auto'
      el.style.height = Math.max(LINE_H, Math.ceil((el.scrollHeight - 1) / LINE_H) * LINE_H) + 'px'
    }, [line.text, line.kind])

    let marker = null
    if (line.kind === 'todo') {
      marker = React.createElement('span', { className: 'sw-marker' },
        React.createElement('button', {
          type: 'button',
          className: 'sw-check',
          role: 'checkbox',
          'aria-checked': String(Boolean(line.done)),
          'aria-label': line.done ? '标记为未完成' : '标记为已完成',
          title: line.done ? '标记为未完成' : '标记为已完成',
          tabIndex: -1,
          onClick: onToggle,
        }, React.createElement('svg', {
          width: 9, height: 9, viewBox: '0 0 10 10', 'aria-hidden': true, focusable: false,
        }, React.createElement('path', {
          d: 'M1.7 5.3 4 7.6 8.4 2.7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }))))
    } else if (line.kind === 'ul') {
      marker = React.createElement('span', { className: 'sw-marker' },
        React.createElement('span', { className: 'sw-bullet' }))
    } else if (line.kind === 'ol') {
      marker = React.createElement('span', { className: 'sw-marker' },
        React.createElement('span', { className: 'sw-order' }, String(number) + '.'))
    }

    return React.createElement('div', {
      className: 'sw-line',
      'data-kind': line.kind,
      'data-done': String(Boolean(line.done)),
    },
      marker,
      React.createElement('textarea', {
        ref,
        id: 'swl-' + line.id,
        className: 'sw-lineText',
        rows: 1,
        value: line.text,
        placeholder,
        spellCheck: false,
        readOnly: collapsed === true,
        'aria-label': line.kind === 'todo' ? '待办事项' : line.kind === 'ol' ? '有序列表项' : line.kind === 'ul' ? '列表项' : '便签正文',
        onChange,
        onKeyDown,
        onPaste,
        onFocus,
      }))
  }

  /**
   * 一张便签。刻意 **不** 订阅 store —— 只收 note + focusId 两个 prop，
   * 外面套 memo：打字时只有正在编辑的那张重渲染，别的纸原样复用（200 张时差 4 倍）。
   */
  const Note = React.memo(function Note({ note, focusId }) {
    const noteRef = React.useRef(null)
    const drag = React.useRef(null)
    const resize = React.useRef(null)
    const [activeId, setActiveId] = React.useState(null)
    const paper = PAPERS[note.color] || PAPERS.yellow
    const width = Math.round(clamp(typeof note.w === 'number' ? note.w : NOTE_W, MIN_NOTE_W, MAX_NOTE_W))
    const minLines = Math.round(clamp(typeof note.minLines === 'number' ? note.minLines : DEFAULT_MIN_LINES, 1, MAX_MIN_LINES))

    const lines = (Array.isArray(note.lines) && note.lines.length > 0)
      ? note.lines
      : [{ id: note.id + '-l0', kind: 'text', text: '', done: false }]

    // 有序列表按「连续 ol 段」重新编号
    const numbering = []
    let counter = 0
    for (const line of lines) {
      if (line.kind === 'ol') {
        counter += 1
        numbering.push(counter)
      } else {
        counter = 0
        numbering.push(0)
      }
    }
    const todoTotal = lines.reduce((n, line) => n + (line.kind === 'todo' ? 1 : 0), 0)
    const todoDone = lines.reduce((n, line) => n + ((line.kind === 'todo' && line.done) ? 1 : 0), 0)
    const activeLine = lines.find((line) => line.id === activeId) || lines[0] || null
    const activeKind = activeLine === null ? 'text' : activeLine.kind

    // ---- 行操作 ----
    // 所有改动都从「当前 state」重新读行：快速连打时闭包里的旧行会把新内容盖掉。
    const pendingFocus = React.useRef(null)
    const [, bumpFocus] = React.useState(0)

    function focusLine(id, caret) {
      pendingFocus.current = { id, caret }
      bumpFocus((tick) => tick + 1)
    }

    // 焦点在 DOM 提交后同步落下（不用定时器，连续输入不会串到上一行）
    React.useLayoutEffect(() => {
      const request = pendingFocus.current
      if (request === null) return
      pendingFocus.current = null
      applyFocus(request.id, request.caret)
    })

    function readLines() {
      const current = state.notes.find((item) => item.id === note.id)
      return (current !== undefined && Array.isArray(current.lines) && current.lines.length > 0)
        ? current.lines
        : lines
    }

    function mutateLines(mutate, opts) {
      const next = mutate(readLines().slice())
      if (next === null || next === undefined) return null
      updateNote(note.id, { lines: next, text: textFromLines(next) }, opts)
      return next
    }

    function patchLine(id, patch, opts) {
      return mutateLines((list) => list.map((item) => (item.id === id ? Object.assign({}, item, patch) : item)), opts)
    }

    function toggleDone(lineId) {
      const current = readLines().find((item) => item.id === lineId)
      if (current === undefined) return
      patchLine(lineId, { done: !current.done })
    }

    function applyKind(kind) {
      const list = readLines()
      const target = list.find((item) => item.id === activeId) || list[0] || null
      if (target === null) return
      if (target.kind !== kind) patchLine(target.id, { kind, done: kind === 'todo' ? Boolean(target.done) : false })
      focusLine(target.id, 'end')
    }

    function splitLine(lineId, before, after) {
      const created = { id: newLineId(), kind: 'text', text: after, done: false }
      let ok = false
      mutateLines((list) => {
        const index = list.findIndex((item) => item.id === lineId)
        if (index === -1) return null
        created.kind = list[index].kind
        list[index] = Object.assign({}, list[index], { text: before })
        list.splice(index + 1, 0, created)
        ok = true
        return list
      })
      if (ok) focusLine(created.id, 'start')
    }

    function mergeIntoPrev(lineId) {
      let targetId = null
      let caret = 0
      mutateLines((list) => {
        const index = list.findIndex((item) => item.id === lineId)
        if (index <= 0) return null
        const prev = list[index - 1]
        targetId = prev.id
        caret = prev.text.length
        list[index - 1] = Object.assign({}, prev, { text: (prev.text + list[index].text).slice(0, MAX_LINE_CHARS) })
        list.splice(index, 1)
        return list
      })
      if (targetId !== null) focusLine(targetId, caret)
    }

    function removeLine(lineId) {
      let targetId = null
      let caret = 'start'
      mutateLines((list) => {
        const index = list.findIndex((item) => item.id === lineId)
        if (index === -1) return null
        if (list.length === 1) {
          // 最后一行不删掉，清空就行 —— 便签总要留一行可写
          list[0] = Object.assign({}, list[0], { kind: 'text', text: '', done: false })
          targetId = list[0].id
          caret = 'start'
          return list
        }
        const target = list[index - 1] || list[index + 1]
        targetId = target.id
        caret = index > 0 ? 'end' : 'start'
        return list.filter((item) => item.id !== lineId)
      })
      if (targetId !== null) focusLine(targetId, caret)
    }

    function onLineChange(lineId, value) {
      const text = value.slice(0, MAX_LINE_CHARS)
      const current = readLines().find((item) => item.id === lineId)
      if (current === undefined) return
      if (current.kind === 'text') {
        for (const trigger of LINE_TRIGGERS) {
          if (trigger.re.test(text)) {
            patchLine(lineId, { kind: trigger.kind, text: '' })
            return
          }
        }
      } else if (current.kind === 'ul' || current.kind === 'ol') {
        // 已经变成列表行了，再敲「[ ] 」就升级成待办
        for (const trigger of LINE_TRIGGERS_SECOND) {
          if (trigger.re.test(text)) {
            patchLine(lineId, { kind: 'todo', done: trigger.done, text: '' })
            return
          }
        }
      }
      patchLine(lineId, { text })
    }

    function onLineKeyDown(event, lineId) {
      if (event.isComposing) return
      const el = event.currentTarget
      if (event.key === 'Escape') {
        el.blur()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        queueSave(note.id, 0)
        notify('已保存', 'ok')
        return
      }
      const list = readLines()
      const index = list.findIndex((item) => item.id === lineId)
      if (index === -1) return
      const current = list[index]

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const start = el.selectionStart
        const end = el.selectionEnd
        // 空正文行上回车：收掉这一行（和大多数编辑器一致）
        if (start === 0 && end === 0 && current.kind === 'text' && current.text === '' && index > 0) {
          removeLine(lineId)
          return
        }
        splitLine(lineId, current.text.slice(0, start), current.text.slice(end))
        return
      }
      if (event.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
        if (current.kind !== 'text') {
          event.preventDefault()
          patchLine(lineId, { kind: 'text', done: false })
          focusLine(lineId, 'start')
          return
        }
        if (current.text === '') {
          event.preventDefault()
          removeLine(lineId)
          return
        }
        if (index > 0) {
          event.preventDefault()
          mergeIntoPrev(lineId)
        }
        return
      }
      if (event.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0 && index > 0) {
        event.preventDefault()
        focusLine(list[index - 1].id, 'end')
        return
      }
      if (event.key === 'ArrowDown' && el.selectionStart === el.value.length && el.selectionEnd === el.value.length && index < list.length - 1) {
        event.preventDefault()
        focusLine(list[index + 1].id, 'start')
      }
    }

    function onLinePaste(event, lineId) {
      const raw = event.clipboardData === null || event.clipboardData === undefined
        ? ''
        : event.clipboardData.getData('text/plain')
      if (typeof raw !== 'string' || raw.indexOf('\n') === -1) return
      event.preventDefault()
      const parts = raw.replace(/\r\n?/g, '\n').split('\n').filter((piece) => piece.trim() !== '')
      if (parts.length === 0) return
      const createdAt = parts.slice(1).map((piece) => lineFromText(piece))
      let focusTarget = null
      mutateLines((list) => {
        const index = list.findIndex((item) => item.id === lineId)
        if (index === -1) return null
        list[index] = Object.assign({}, list[index], { text: lineFromText(parts[0]).text })
        list.splice(index + 1, 0, ...createdAt)
        focusTarget = createdAt.length > 0 ? createdAt[createdAt.length - 1].id : list[index].id
        return list
      })
      if (focusTarget !== null) focusLine(focusTarget, 'end')
    }

    // 新建后自动聚焦（focusId 是行 id）
    React.useEffect(() => {
      const target = focusId
      if (target === null || target === undefined) return
      if (!readLines().some((line) => line.id === target)) return
      setState({ focusId: null })
      focusLine(target, 'end')
    }, [focusId, note.id])

    function onHeadPointerDown(event) {
      if (event.button !== 0) return
      if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('button')) return
      const el = noteRef.current
      const canvas = el === null ? null : el.parentElement
      if (el === null || canvas === null) return
      const canvasRect = canvas.getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left - canvasRect.left,
        top: rect.top - canvasRect.top,
        dx: 0,
        dy: 0,
        moved: false,
        canvasW: Math.max(1, canvasRect.width),
        canvasH: Math.max(1, canvasRect.height),
        maxLeft: Math.max(0, canvasRect.width - rect.width - 2),
        maxTop: Math.max(0, canvasRect.height - 48),
      }
      el.setAttribute('data-dragging', 'true')
      if (typeof el.setPointerCapture === 'function') {
        try { el.setPointerCapture(event.pointerId) } catch { /* 某些浏览器在合成事件下会抛，忽略 */ }
      }
      setState({ dragId: note.id })
      raise(note.id)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
      event.preventDefault()
    }

    function onPointerMove(event) {
      const current = drag.current
      if (current === null || event.pointerId !== current.pointerId) return
      const dx = event.clientX - current.startX
      const dy = event.clientY - current.startY
      current.dx = clamp(dx, -current.left, current.maxLeft - current.left)
      current.dy = clamp(dy, -current.top, current.maxTop - current.top)
      if (Math.abs(dx) + Math.abs(dy) > 3) current.moved = true
      const el = noteRef.current
      if (el !== null) {
        el.style.transform = 'translate(' + current.dx + 'px,' + current.dy + 'px)'
      }
    }

    function onPointerUp() {
      const current = drag.current
      if (current === null) return
      drag.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      const el = noteRef.current
      if (el !== null) {
        el.removeAttribute('data-dragging')
        if (current.moved) {
          const x = round1(clamp((current.left + current.dx) / current.canvasW * 100, 0, 92))
          const y = round1(clamp((current.top + current.dy) / current.canvasH * 100, 0, 88))
          // 先落位再清 transform，避免松手瞬间闪回
          el.style.left = x + '%'
          el.style.top = y + '%'
          el.style.transform = ''
          setState({ dragId: null })
          updateNote(note.id, { x, y })
          return
        }
        el.style.transform = ''
      }
      setState({ dragId: null })
    }

    // ---- 拖右下角改大小：宽度按 px，高度按整行 ----
    const lastResizeTap = React.useRef(0)

    function onResizePointerDown(event) {
      if (event.button !== 0) return
      const el = noteRef.current
      if (el === null) return
      // pointerdown 上 preventDefault 会吞掉兼容鼠标事件（click/dblclick），
      // 所以「双击回默认」自己按时间戳判，不依赖 dblclick。
      const now = Date.now()
      if (now - (lastResizeTap.current || 0) < 320) {
        lastResizeTap.current = 0
        onResizeReset()
        event.preventDefault()
        return
      }
      lastResizeTap.current = now
      const body = el.querySelector('.sw-body')
      const rect = el.getBoundingClientRect()
      resize.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        bodyH: body === null ? 0 : body.offsetHeight,
      }
      el.setAttribute('data-resizing', 'true')
      setState({ dragId: note.id })
      raise(note.id)
      if (typeof el.setPointerCapture === 'function') {
        try { el.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
      }
      window.addEventListener('pointermove', onResizeMove)
      window.addEventListener('pointerup', onResizeUp)
      window.addEventListener('pointercancel', onResizeUp)
      event.preventDefault()
      event.stopPropagation()
    }

    function onResizeMove(event) {
      const current = resize.current
      if (current === null || event.pointerId !== current.pointerId) return
      const nextW = Math.round(clamp(current.width + (event.clientX - current.startX), MIN_NOTE_W, MAX_NOTE_W))
      const content = current.bodyH + (event.clientY - current.startY) - PAD_TOP - PAD_BOTTOM
      const nextLines = Math.round(clamp(Math.round(content / LINE_H), 1, MAX_MIN_LINES))
      const el = noteRef.current
      if (el === null) return
      el.style.width = nextW + 'px'
      el.style.setProperty('--sw-min-lines', String(nextLines))
    }

    function onResizeUp() {
      const current = resize.current
      if (current === null) return
      resize.current = null
      window.removeEventListener('pointermove', onResizeMove)
      window.removeEventListener('pointerup', onResizeUp)
      window.removeEventListener('pointercancel', onResizeUp)
      const el = noteRef.current
      setState({ dragId: null })
      if (el === null) return
      el.removeAttribute('data-resizing')
      const nextW = Math.round(clamp(parseFloat(el.style.width) || width, MIN_NOTE_W, MAX_NOTE_W))
      const nextLines = Math.round(clamp(parseFloat(el.style.getPropertyValue('--sw-min-lines')) || minLines, 1, MAX_MIN_LINES))
      updateNote(note.id, { w: nextW, minLines: nextLines })
    }

    /** 双击手柄回到默认大小。 */
    function onResizeReset() {
      updateNote(note.id, { w: NOTE_W, minLines: DEFAULT_MIN_LINES })
    }

    React.useEffect(() => () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('pointermove', onResizeMove)
      window.removeEventListener('pointerup', onResizeUp)
      window.removeEventListener('pointercancel', onResizeUp)
    }, [])

    const zIndex = Math.min(40000, 100 + Math.round(note.z || 0) + (note.pinned ? 20000 : 0))
    const ruled = note.ruled !== false
    const collapsed = note.collapsed === true

    return React.createElement('div', {
      ref: noteRef,
      className: 'sw-note',
      'data-note-id': note.id,
      'data-pinned': String(Boolean(note.pinned)),
      'data-ruled': String(ruled),
      'data-collapsed': String(collapsed),
      style: Object.assign({
        left: note.x + '%',
        top: note.y + '%',
        width: width + 'px',
        zIndex,
        backgroundColor: paper.bg,
        color: paper.ink,
        '--sw-paper': paper.bg,
        '--sw-lh': LINE_H + 'px',
        '--sw-pad-top': PAD_TOP + 'px',
        '--sw-pad-bottom': PAD_BOTTOM + 'px',
        '--sw-min-lines': String(minLines),
      }, PAPER_STYLE),
      onDoubleClick: (event) => event.stopPropagation(),
    },
      React.createElement('div', {
        className: 'sw-noteHead',
        onPointerDown: onHeadPointerDown,
        title: '按住这里拖动便签',
      },
        React.createElement('span', { className: 'sw-grip' }, React.createElement(Icon, { size: 13 }, gripPath)),
        React.createElement('span', { className: 'sw-time' }, relTime(note.updatedAt)),
        todoTotal > 0 ? React.createElement('span', {
          className: 'sw-progress',
          title: '待办完成 ' + todoDone + ' / ' + todoTotal,
          'aria-label': '待办完成 ' + todoDone + ' / ' + todoTotal,
        }, todoDone + '/' + todoTotal) : null,
        React.createElement('div', { className: 'sw-noteBtns' },
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': collapsed ? '展开便签' : '收起便签',
            'aria-pressed': String(collapsed),
            title: collapsed ? '展开' : '收起（只留两行）',
            onClick: () => updateNote(note.id, { collapsed: !collapsed }),
          }, React.createElement(Icon, { size: 13 }, collapsed ? expandPath : collapsePath)),
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': ruled ? '关掉横线' : '打开横线',
            'aria-pressed': String(ruled),
            title: ruled ? '关掉横线' : '打开横线',
            onClick: () => updateNote(note.id, { ruled: !ruled }),
          }, React.createElement(Icon, { size: 13 }, ruledPath)),
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': note.pinned ? '取消置顶' : '置顶',
            'aria-pressed': String(Boolean(note.pinned)),
            title: note.pinned ? '取消置顶' : '置顶',
            onClick: () => updateNote(note.id, { pinned: !note.pinned }),
          }, React.createElement(Icon, { size: 13 }, pinPath)),
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': '删除便签',
            title: '删除便签（先进回收站）',
            onClick: () => removeNote(note.id),
          }, React.createElement(Icon, { size: 13 }, trashPath)))),
      React.createElement('div', {
        className: 'sw-body',
        // 收起时点一下就展开；但如果用户是在选词（selection 非空）就别抢
        onClick: collapsed ? (event) => {
          if (event.target !== null && event.target.closest !== undefined && event.target.closest('button, .sw-check') !== null) return
          const selection = window.getSelection()
          if (selection !== null && selection.toString() !== '') return
          updateNote(note.id, { collapsed: false })
        } : undefined,
      },
        lines.map((line, index) => React.createElement(NoteLine, {
          key: line.id,
          line,
          number: numbering[index],
          collapsed,
          placeholder: (lines.length === 1 && index === 0) ? '写点什么…' : '',
          onToggle: () => toggleDone(line.id),
          onChange: (event) => onLineChange(line.id, event.target.value),
          onKeyDown: (event) => onLineKeyDown(event, line.id),
          onPaste: (event) => onLinePaste(event, line.id),
          onFocus: () => { if (activeId !== line.id) setActiveId(line.id) },
        }))),
      collapsed ? React.createElement('button', {
        type: 'button',
        className: 'sw-collapsedChip',
        'aria-label': '展开便签正文',
        title: '展开（折叠时也能直接选文字）',
        onClick: () => updateNote(note.id, { collapsed: false }),
      }, '展开') : null,
      React.createElement('div', { className: 'sw-noteFoot' },
        React.createElement('div', { className: 'sw-swatches', role: 'group', 'aria-label': '便签纸色' },
          COLOR_KEYS.map((key) => React.createElement('button', {
            key,
            type: 'button',
            className: 'sw-swatch',
            style: { background: PAPERS[key].bg },
            'aria-label': '换成' + PAPERS[key].label + '色',
            'aria-pressed': String(note.color === key),
            title: PAPERS[key].label,
            onClick: () => updateNote(note.id, { color: key }),
          }))),
        React.createElement('span', { className: 'sw-footSep', 'aria-hidden': true }),
        React.createElement('div', { className: 'sw-fmt', role: 'group', 'aria-label': '当前行的格式' },
          FORMATS.map((format) => React.createElement('button', {
            key: format.kind,
            type: 'button',
            className: 'sw-fmtBtn',
            'aria-label': format.label,
            'aria-pressed': String(activeKind === format.kind),
            title: format.label,
            onClick: () => applyKind(format.kind),
          }, React.createElement(Icon, { size: 18 }, format.icon))))),
      React.createElement('button', {
        type: 'button',
        className: 'sw-resize',
        'aria-label': '拖动调整便签大小，双击恢复默认',
        title: '拖动调整大小 · 双击恢复默认',
        onPointerDown: onResizePointerDown,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onResizeReset()
        },
      }, React.createElement(Icon, { size: 11 }, resizePath)))
  })

  // -------------------------------------------------------------------------
  // 回收站（右侧抽屉）
  // -------------------------------------------------------------------------

  /** 一张回收站卡片：纸色条 + 前两行预览 + 删除时间 + 恢复/彻底删除。 */
  function TrashItem({ item }) {
    const paper = PAPERS[item.color] || PAPERS.yellow
    const [confirm, setConfirm] = React.useState(false)
    React.useEffect(() => {
      if (!confirm) return undefined
      const timer = setTimeout(() => setConfirm(false), 3000)
      return () => clearTimeout(timer)
    }, [confirm])
    const preview = (Array.isArray(item.lines) ? item.lines : [])
      .map((line) => (typeof line.text === 'string' ? line.text.trim() : ''))
      .filter((text) => text !== '')
      .slice(0, 2)
      .join(' · ')
    return React.createElement('div', { className: 'sw-trashItem', 'data-note-id': item.id },
      React.createElement('span', { className: 'sw-trashSwatch', style: { background: paper.bg }, 'aria-hidden': true }),
      React.createElement('div', { className: 'sw-trashMain' },
        React.createElement('div', { className: 'sw-trashText' }, preview === '' ? '（空白便签）' : preview),
        React.createElement('div', { className: 'sw-trashWhen' }, '删除于 ' + relTime(item.deletedAt))),
      React.createElement('div', { className: 'sw-trashActions' },
        React.createElement('button', {
          type: 'button',
          className: 'sw-miniBtn',
          onClick: () => restoreNote(item.id),
        }, '恢复'),
        React.createElement('button', {
          type: 'button',
          className: 'sw-miniBtn sw-miniBtn--danger',
          onClick: () => {
            if (confirm) purgeNote(item.id)
            else setConfirm(true)
          },
        }, confirm ? '确认删除' : '彻底删除')))
  }

  /**
   * 右侧回收站抽屉：默认收起成一条窄标签（带数量），点开是抽屉面板；
   * 面板上的图钉可以「固定」，固定后点别处不会自动收起（偏好记在 localStorage）。
   */
  function TrashDrawer() {
    const wall = useWall()
    const items = wall.trash
    const open = wall.trashOpen
    const pinned = wall.trashPinned
    if (!open) return null
    return React.createElement('div', {
      className: 'sw-trash',
      'data-pinned': String(pinned),
      role: 'region',
      'aria-label': '回收站',
    },
      React.createElement('div', { className: 'sw-trashPanel' },
        React.createElement('div', { className: 'sw-trashHead' },
          React.createElement('span', { className: 'sw-trashTitle' }, '回收站'),
          React.createElement('span', { className: 'sw-trashMeta' }, items.length > 0 ? items.length + ' 张' : '空'),
          React.createElement('div', { className: 'sw-spacer' }),
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': pinned ? '取消固定' : '固定打开',
            'aria-pressed': String(pinned),
            title: pinned ? '取消固定' : '固定打开',
            onClick: toggleTrashPin,
          }, React.createElement(Icon, { size: 13 }, pinPath)),
          React.createElement('button', {
            type: 'button',
            className: 'sw-iconBtn',
            'aria-label': '关闭回收站',
            title: '关闭',
            onClick: () => setState({ trashOpen: false }),
          }, React.createElement(Icon, { size: 13 }, closePath))),
        items.length === 0
          ? React.createElement('div', { className: 'sw-trashEmpty' }, '回收站是空的。\n删掉的便签会先落到这里，不会立刻消失。')
          : React.createElement('div', { className: 'sw-trashList' },
            items.map((item) => React.createElement(TrashItem, { key: item.id, item }))),
        items.length === 0 ? null : React.createElement('div', { className: 'sw-trashFoot' },
          React.createElement('button', {
            type: 'button',
            className: 'sw-btn sw-btn--danger',
            onClick: () => {
              if (wall.confirmPurge) purgeAllTrash()
              else setState({ confirmPurge: true })
            },
          }, wall.confirmPurge ? '再点一次清空' : '清空回收站'))))
  }

  // -------------------------------------------------------------------------
  // 主面板
  // -------------------------------------------------------------------------

  function WallPanel() {
    const wall = useWall()
    const canvasRef = React.useRef(null)
    const wallRef = React.useRef(null)
    const searchRef = React.useRef(null)
    const [scrollState, setScrollState] = React.useState({ scrollable: false, atTop: true, atBottom: false })
    /** 最后一张纸的底边（相对画布）。画布本身有 640px 的 min-height，不能拿 scrollHeight 判断「有没有东西可滚」。 */
    const contentBottom = React.useRef(0)

    function measureContent() {
      const el = wallRef.current
      const canvas = el === null ? null : el.querySelector('.sw-canvas')
      if (canvas === null || canvas === undefined) return 0
      let bottom = 0
      for (const child of canvas.children) {
        if (child.classList === undefined || !child.classList.contains('sw-note')) continue
        bottom = Math.max(bottom, child.offsetTop + child.offsetHeight)
      }
      return bottom
    }

    /**
     * 量一下墙能不能滚、滚到哪了。
     * @param {boolean} full 是否重新量内容高度（滚动事件里不需要，避免每次滚动都读一堆 offset）
     */
    function syncScroll(full) {
      const el = wallRef.current
      if (el === null) return
      if (full === true) contentBottom.current = measureContent()
      // 只有「纸真的伸到视口下面」才算能滚；空着的那截画布不算
      const scrollable = contentBottom.current > el.clientHeight + 8
      const atTop = el.scrollTop <= 4
      const atBottom = el.scrollTop + el.clientHeight >= Math.min(el.scrollHeight, contentBottom.current) - 6
      if (scrollable === scrollState.scrollable && atTop === scrollState.atTop && atBottom === scrollState.atBottom) return
      setScrollState({ scrollable, atTop, atBottom })
    }

    function scrollToEdge(edge) {
      const el = wallRef.current
      if (el === null) return
      el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' })
    }

    // 首屏加载 + 可见时轮询（让模型用工具贴的便签也能自己出现）
    // 轮询只要便签 + 回收站条数：回收站明细可能有几百张，没必要每 6 秒全传一遍
    React.useEffect(() => {
      load(false, true)
      const timer = setInterval(() => {
        if (document.visibilityState === 'visible') load(true, false)
      }, 6000)
      const onVisibility = () => {
        if (document.visibilityState === 'visible') load(true, false)
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisibility)
        // 离开面板时把还没落盘的改动冲掉，不留丢失窗口
        for (const id of Array.from(dirty)) {
          const pending = saveTimers.get(id)
          if (pending) clearTimeout(pending)
          saveTimers.delete(id)
          flush(id)
        }
      }
    }, [])

    React.useEffect(() => {
      if (wall.confirmClear !== true) return
      const timer = setTimeout(() => setState({ confirmClear: false }), 4000)
      return () => clearTimeout(timer)
    }, [wall.confirmClear])

    // 回收站的「再点一次清空」同样要自动复位 —— 否则关掉抽屉再打开，一次点击就把回收站端了
    React.useEffect(() => {
      if (wall.confirmPurge !== true) return
      const timer = setTimeout(() => setState({ confirmPurge: false }), 4000)
      return () => clearTimeout(timer)
    }, [wall.confirmPurge])

    // 抽屉一关，确认状态就作废
    React.useEffect(() => {
      if (wall.trashOpen !== true && wall.confirmPurge === true) setState({ confirmPurge: false })
    }, [wall.trashOpen])

    // 滚动按钮的可见性：挂载后量一次，之后跟着滚动 / 尺寸变化 / 便签数量刷新
    React.useEffect(() => {
      syncScroll(true)
      const el = wallRef.current
      if (el === null) return undefined
      wallEl = el
      let frame = 0
      const onScroll = () => {
        if (frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          syncScroll(false) // 滚动时只更新头尾状态，不重新量内容
        })
      }
      el.addEventListener('scroll', onScroll, { passive: true })
      const observer = new ResizeObserver(() => syncScroll(true))
      observer.observe(el)
      if (canvasRef.current !== null) observer.observe(canvasRef.current)
      const onResize = () => syncScroll(true)
      window.addEventListener('resize', onResize)
      const timer = setInterval(() => syncScroll(true), 1200)
      return () => {
        el.removeEventListener('scroll', onScroll)
        if (frame !== 0) cancelAnimationFrame(frame)
        observer.disconnect()
        window.removeEventListener('resize', onResize)
        clearInterval(timer)
        if (wallEl === el) wallEl = null
      }
    }, [])

    React.useEffect(() => {
      syncScroll(true)
    }, [wall.notes.length, wall.trashOpen])

    // 抽屉开着时 Esc 直接关掉（正在写便签时让 Esc 先给输入框）
    React.useEffect(() => {
      if (wall.trashOpen !== true) return undefined
      const onKeyDown = (event) => {
        if (event.key !== 'Escape') return
        const active = document.activeElement
        if (active !== null && active.tagName === 'TEXTAREA') return
        setState({ trashOpen: false })
      }
      document.addEventListener('keydown', onKeyDown)
      return () => document.removeEventListener('keydown', onKeyDown)
    }, [wall.trashOpen])

    const query = wall.query.trim().toLowerCase()
    const shown = wall.notes.filter((note) => {
      if (wall.pinnedOnly && !note.pinned) return false
      if (query !== '' && !note.text.toLowerCase().includes(query)) return false
      return true
    })

    function onCanvasDoubleClick(event) {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      const x = round1(clamp((event.clientX - rect.left - NOTE_W / 2) / Math.max(1, rect.width) * 100, 0, 92))
      const y = round1(clamp((event.clientY - rect.top - 12) / Math.max(1, rect.height) * 100, 0, 88))
      createNote({ x, y })
    }

    function onSearchKeyDown(event) {
      if (event.key === 'Escape') {
        setState({ query: '' })
        event.currentTarget.blur()
      }
    }

    const status = wall.status
    let statusNode
    if (status === 'loading') {
      statusNode = React.createElement('span', { className: 'sw-status' }, '读取中…')
    } else if (status === 'error') {
      statusNode = React.createElement('button', {
        type: 'button',
        className: 'sw-status sw-status--error',
        title: wall.error + '\n点击重试',
        onClick: () => { load(false, true); queueSaveAll() },
      }, '未同步 · 重试')
    } else if (wall.saving > 0) {
      statusNode = React.createElement('span', { className: 'sw-status' }, '保存中…')
    } else {
      statusNode = React.createElement('span', { className: 'sw-status' }, wall.savedAt > 0 ? '已保存 ' + clockOf(wall.savedAt) : '已同步')
    }

    const empty = wall.notes.length === 0
    const noneMatched = !empty && shown.length === 0

    // 提示条（最多 3 条），单独算好再塞进树里，省得嵌套太深看不清括号
    const toastNodes = wall.toasts.map((toast) => React.createElement('div', {
      key: toast.id,
      className: 'sw-toast',
      'data-kind': toast.kind,
      role: 'status',
    },
      React.createElement('span', { className: 'sw-toastText' }, toast.text),
      toast.action ? React.createElement('button', {
        type: 'button',
        className: 'sw-toastAction',
        onClick: () => {
          const action = toast.action
          dismissToast(toast.id)
          if (action) action.run()
        },
      }, toast.action.label) : null))

    return React.createElement('div', { className: 'sw-root', role: 'region', 'aria-label': '便签墙' },
      React.createElement('div', { className: 'sw-head' },
        React.createElement('div', { className: 'sw-brand' },
          React.createElement('span', { className: 'sw-title' }, '便签墙'),
          React.createElement('span', { className: 'sw-count' }, wall.notes.length + ' 条')),
        React.createElement('div', { className: 'sw-spacer' }),
        React.createElement('div', { className: 'sw-search' },
          React.createElement(Icon, { size: 13 }, searchPath),
          React.createElement('input', {
            ref: searchRef,
            type: 'search',
            value: wall.query,
            placeholder: '搜索便签',
            'aria-label': '搜索便签',
            spellCheck: false,
            onChange: (event) => setState({ query: event.target.value }),
            onKeyDown: onSearchKeyDown,
          }),
          wall.query === '' ? null : React.createElement('button', {
            type: 'button',
            className: 'sw-search-clear',
            'aria-label': '清除搜索',
            title: '清除搜索',
            onClick: () => {
              setState({ query: '' })
              if (searchRef.current) searchRef.current.focus()
            },
          }, React.createElement(Icon, { size: 10 }, closePath))),
        React.createElement('button', {
          type: 'button',
          className: 'sw-btn',
          'aria-label': '只看置顶',
          'aria-pressed': String(wall.pinnedOnly),
          title: '只看置顶便签（和便签抬头那个「置顶」不是一回事）',
          onClick: () => setState({ pinnedOnly: !wall.pinnedOnly }),
        }, React.createElement(Icon, { size: 13 }, pinPath), '只看置顶'),
        React.createElement('button', {
          type: 'button',
          className: 'sw-btn sw-btn--primary',
          onClick: () => createNote(null, canvasRef.current),
        }, React.createElement(Icon, { size: 13 }, plusPath), '新建便签'),
        React.createElement('button', {
          type: 'button',
          className: 'sw-btn',
          disabled: empty,
          title: '按网格重新摆放',
          onClick: () => arrange(canvasRef.current),
        }, React.createElement(Icon, { size: 13 }, gridPath), '整理'),
        React.createElement('button', {
          type: 'button',
          className: 'sw-btn sw-btn--danger',
          disabled: empty,
          title: '清空整面墙（需要点两次）',
          onClick: () => {
            if (wall.confirmClear) clearAll()
            else setState({ confirmClear: true })
          },
        }, wall.confirmClear ? '再点一次清空' : '清空'),
        React.createElement('button', {
          type: 'button',
          className: 'sw-btn sw-btn--trash',
          'aria-label': '回收站',
          'aria-pressed': String(wall.trashOpen),
          title: '回收站：' + wall.trash.length + ' 张（点开抽屉）',
          onClick: toggleTrash,
        },
          React.createElement(Icon, { size: 13 }, trashPath),
          '回收站',
          wall.trash.length > 0 ? React.createElement('span', { className: 'sw-badge', 'aria-hidden': true }, wall.trash.length > 99 ? '99+' : String(wall.trash.length)) : null)),
      React.createElement('div', { className: 'sw-main' },
        React.createElement('div', { className: 'sw-wall', ref: wallRef, tabIndex: -1 },
          React.createElement('div', {
            ref: canvasRef,
            className: 'sw-canvas',
            onDoubleClick: onCanvasDoubleClick,
          },
            shown.map((note) => React.createElement(Note, {
              key: note.id,
              note,
              focusId: wall.focusId,
            })),
            empty ? React.createElement('div', { className: 'sw-empty' },
              React.createElement(Icon, { size: 44, viewBox: '0 0 24 24' }, React.createElement(React.Fragment, null,
                React.createElement('path', { d: 'M5 4h11v9.5L12.5 18H5z' }),
                React.createElement('path', { d: 'M11 18v-4.5h4.5' }),
                React.createElement('path', { d: 'M8 8h5 M8 11h3' }))),
              React.createElement('div', { className: 'sw-empty-title' }, '墙上还空着'),
              React.createElement('div', { className: 'sw-empty-desc' }, '点「新建便签」贴第一张；之后双击空白处就能随手加一张，按住纸头拖到任意位置。正文里敲「- 」「1. 」直接变清单。'),
              React.createElement('button', {
                type: 'button',
                className: 'sw-btn sw-btn--primary',
                onClick: () => createNote(null, canvasRef.current),
              }, React.createElement(Icon, { size: 13 }, plusPath), '新建便签')) : null,
            noneMatched ? React.createElement('div', { className: 'sw-empty' },
              React.createElement('div', { className: 'sw-empty-title' }, wall.pinnedOnly && query === '' ? '没有置顶的便签' : '没有匹配的便签'),
              React.createElement('div', { className: 'sw-empty-desc' }, '换个关键词，或点「置顶」取消筛选。')) : null)),
        // 只有墙真的能滚时才出现：一键到最上 / 最下
        React.createElement('div', { className: 'sw-scroll', 'data-visible': String(scrollState.scrollable) },
          React.createElement('button', {
            type: 'button',
            className: 'sw-scrollBtn',
            'aria-label': '滚到最上',
            title: '滚到最上',
            disabled: scrollState.atTop,
            onClick: () => scrollToEdge('top'),
          }, React.createElement(Icon, { size: 13 }, expandPath)),
          React.createElement('button', {
            type: 'button',
            className: 'sw-scrollBtn',
            'aria-label': '滚到最下',
            title: '滚到最下',
            disabled: scrollState.atBottom,
            onClick: () => scrollToEdge('bottom'),
          }, React.createElement(Icon, { size: 13 }, collapsePath))),
        React.createElement(TrashDrawer, null),
        wall.trashOpen && !wall.trashPinned ? React.createElement('div', {
          className: 'sw-trashScrim',
          onClick: () => setState({ trashOpen: false }),
        }) : null),
      React.createElement('div', { className: 'sw-foot' },
        React.createElement('span', { className: 'sw-foot-tip' }, '回车换行 · 「- 」「1. 」变清单 · 悬停纸条切换格式与纸色'),
        React.createElement('div', { className: 'sw-spacer' }),
        wall.store === null || typeof wall.store.path !== 'string' ? null : React.createElement('button', {
          type: 'button',
          className: 'sw-path',
          'data-configured': String(Boolean(wall.store.configured)),
          title: '便签数据存在这里：\n' + wall.store.path + '\n（可在插件配置 storePath 里改）\n点一下复制路径',
          onClick: () => copyStorePath(wall.store.path),
        }, shortPath(wall.store.path)),
        statusNode),
      toastNodes.length === 0 ? null : React.createElement('div', { className: 'sw-toasts' }, toastNodes))
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  /**
   * 注册 UI 的两个落点：
   *   sidebar.panellist  list 槽位，id 就是主面板 key；
   *   main               keyed 槽位，点侧栏图标 → layout.selectPanel('sticky-wall') → 派发同名 key。
   * slots 是客户端早期就绪的核心服务，但为了不和加载顺序赌，优先走 cordis 的 inject 等待。
   */
  function registerUi(scope) {
    const slots = (scope === null || scope === undefined)
      ? undefined
      : ((scope.slots !== undefined) ? scope.slots : (typeof scope.get === 'function' ? scope.get('slots') : undefined))
    if (slots === undefined || slots === null) {
      console.error('[dsh-plugin-sticky-wall] 缺少 slots 服务，UI 半侧不注册')
      return
    }
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 20,
      label: '便签墙',
    }, SidebarIcon))

    slots.inject('main', () => slots.register({
      name: 'main',
      key: PANEL_ID,
    }, WallPanel))
  }

  exports.apply = function apply(ctx) {
    installStyles()
    if (typeof ctx.inject === 'function') {
      ctx.inject(['slots'], registerUi)
      return
    }
    registerUi(ctx)
  }

  return exports
}})
