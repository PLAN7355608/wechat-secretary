/**
 * dsh-wechat-secretary（Host 半边）
 *
 * 职责：
 *  1) 轮询本地微信 bridge（由使用者自备，接口约定见 README）的收件箱 /inbox；
 *  2) 把白名单会话（默认只有主人）的新消息交给一个 DSH 会话执行；
 *  3) 会话产出最终回复后，通过 bridge /send 用键盘/剪贴板把消息发回微信；
 *  4) 提供 wechat_secretary_status / _send / _ask 三个工具便于排查。
 *
 * 只监听 127.0.0.1 上的 bridge；不直连微信、不读微信库（读库在 sidecar 里做）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { appendFileSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, renameSync, statSync, utimesSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createMemory, parseMoodTag, stripMoodTags } from './memory.js'

export const name = 'dsh-wechat-secretary'
export const inject = ['tools']

const DEFAULTS = {
  bridgeUrl: 'http://127.0.0.1:8710',
  // 启动自检 + 自动拉起本地 bridge：DSH 重启后 bridge 不会自己起来，通道就断了。
  // 插件起来后探一次健康检查，连不上就用下面的解释器把 sidecar 拉起来。
  // 不碰系统设置、不需要管理员、不杀进程；拉起失败只记日志（连续 5 次停手）。
  autoStartSidecar: false,
  sidecarPythonPath: '',
  sidecarScriptPath: './bridge/sidecar.py',
  sidecarHealthUrl: 'http://127.0.0.1:8710/health',
  // 探测节奏与拉起退避：探活每 15 秒一次；真正 spawn 至少间隔 60 秒；连续失败 5 次停手。
  sidecarProbeIntervalMs: 15000,
  sidecarStartMinGapMs: 60000,
  sidecarStartMaxFails: 5,
  cwd: '<YOUR_WORKSPACE>',
  // 插件建会话时用的 agent 模式；对应 preset id（Secretary 模式 = secretary）
  agentPreset: 'secretary',
  whitelist: [],
  pollMs: 1000,
  replyEnabled: true,
  // 不再发「收到，正在办」：那股机器人味太重，让秘书自己开口。
  // 改为「慢提示」：超过 slowNoticeSec 秒还没出结果，才补一句话说清情况（0 = 关闭）。
  slowNoticeSec: 180,
  slowNoticeText: '还在办，这一步比平时慢；有结果我马上发你。',
  // 进度汇报：每 progressEverySec 秒往微信回一句进度，让主人知道没卡死（0 = 关闭）。
  progressEverySec: 300,
  progressText: '已跑 {mins} 分钟，还在办；有结果我马上发。',
  // 微信叫停词：命中等号「取消当前这单」，用逗号分隔；留空 = 关闭叫停功能。
  stopWords: '停,停止,取消,/stop,停下,别做了,算了',
  // 等待上限：0 = 不设上限（靠 turn/end、45s 无事件、主人叫停退出）；>0 = 到点放弃并留台账。
  maxWaitMs: 0,
  // 积压消息：桥重启或离线后旧消息被一把捞进时，超过 backlogAgeMin 分钟算过期；
  // 一批里过期消息达到 backlogMergeMin 条，就合并成一条摘要，不逐条当新指令办（0 = 关闭）。
  // 派活回执：目标会话跑完后把最后一段回答搬回本会话
  reflowTimeoutMin: 30,
  reflowScanSec: 20,
  reflowMaxChars: 1200,
  reflowMode: 'summary',
  reflowModes: {},
  backlogAgeMin: 10,
  backlogMergeMin: 3,
  // 会话间"插话"（session.prompt mode=steer）默认关闭：往正在跑的那一轮里塞话风险高，
  // 主人显式打开才允许；"派活"（mode=queue）不受这个开关影响。
  allowSteer: false,
  // 派活前是否顺手把目标会话的审批策略降到 never：目标会话若是 ask，一进场就会被
  // 审批门挡成 blocked（2026-11-04 19:45 实测，派过去的活直接 turn/end blocked）。
  // 默认开；设 false 表示完全不碰别的会话的审批策略。
  dispatchRelaxApproval: true,
  // 秘书会话的 DSH 权限预设（沙箱档位）。秘书要能碰桌面/下载目录这类工作区外的位置，
  // 所以默认给「完全权限」；真正的高危动作由下面的硬拦截 + 微信审批兜住。
  // 可选值以 permissionPresets.catalog() 为准（本机：只读 / 工作区可写 / 完全权限 / 自动审查）。
  // 本机 catalog 的 value 是英文键：read-only / workspace-write / danger-full-access / auto；对应 GUI 显示：只读 / 工作区可写 / 完全权限 / 自动审查。
  permissionPreset: 'danger-full-access',
  // 硬拦截：秘书会话的系统审批策略是 never（手机点不了审批框），删/装/改系统这类命令
  // 由 tool guard 硬拦，必须先在微信里经 wechat_secretary_approve 批准（10 分钟一次性放行）。
  hardGuard: true,
  statePath: 'data/plugin-state.json',
  timeZone: 'Asia/Hong_Kong',
  // 设备侧（手机运行时）接口，契约见 README 的「设备侧接口」一节。
  // 默认关闭：硬件到位、或有可用的设备侧 mock 时才启用。
  device: {
    enabled: false,
    transport: 'http',
    baseUrl: 'http://<DEVICE_LAN_IP>:8720',
    token: '',
    heartbeatMs: 30000,
    offlineAfterMs: 60000,
    fallbackText: '我现在不在工位，消息先记下了，回工位就处理。',
  },
  // 阶段④ 秘书记忆（代码在 memory.js，纯文件零依赖）。
  // enabled=false 即整体回滚：不读不写、不拦指令、不注入。
  memory: {
    enabled: true,
    dir: '', // 空 = 与 plugin-state.json 同级的 memory/
    injectBudgetChars: 1100,
    profileBudgetChars: 300,
    factsMax: 5,
    pendingMax: 5,
    dailyMax: 3,
    recentDays: 7,
    halfLifeDays: 14,
    autoWriteTasks: true,
    autoWriteDaily: true,
    deviceId: '', // 必配：写 'home-pc' / 'linux-vm'；留空则落 deviceId=unset + 启动告警（不许默认假装是 home-pc）
    // 阶段④-情绪（方案 A：回答末尾隐藏标记 + 注入口吻段；情绪不进 facts）
    mood: true,
    moodInjectChars: 120, // 120 才放得下"看法（判断+依据）"和校准句，80 会挤掉看法行
    moodMaxRecords: 3,
    moodRecentDays: 7,
    moodRetentionDays: 30,
  },
}

const TEXT_OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [
    { type: 'text', text: String(value && value.message ? value.message : '') },
  ],
}

/**
 * 单实例锁：同一台电脑只允许一个插件实例轮询 bridge。
 *
 * 为什么必须有：两个实例同时轮询，同一条微信消息会被处理两遍（两遍回执、两遍回答），
 * 而且两边会抢同一个微信窗口、互相把名字粘进搜索框，直接把消息发丢
 * （2026-10-29 20:02 的事故就是这个）。锁文件写在 plugin-state.json 旁边。
 */
const INSTANCE_ID = Math.random().toString(36).slice(2, 10)

function acquireInstanceLock(statePath) {
  const lockPath = join(dirname(statePath), 'plugin.lock')
  try {
    mkdirSync(dirname(statePath), { recursive: true })
  } catch {
    /* ignore */
  }
  const claim = () => {
    const fd = openSync(lockPath, 'wx')
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, inst: INSTANCE_ID, at: Date.now() }))
    } finally {
      closeSync(fd)
    }
  }
  try {
    claim()
    return { ok: true, path: lockPath }
  } catch (e) {
    if (e && e.code !== 'EEXIST') return { ok: true, path: lockPath, unmanaged: true }
  }
  try {
    const st = statSync(lockPath)
    let old = null
    try {
      old = JSON.parse(readFileSync(lockPath, 'utf8'))
    } catch {
      /* ignore */
    }
    const stale = Date.now() - st.mtimeMs > 120000
    const otherInstanceSameProcess = Number(old && old.pid) === process.pid && (!old || old.inst !== INSTANCE_ID)
    if (stale || otherInstanceSameProcess) {
      try {
        unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
      try {
        claim()
        return { ok: true, path: lockPath }
      } catch {
        return { ok: false, path: lockPath }
      }
    }
    return { ok: false, path: lockPath, holder: old }
  } catch {
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
    try {
      claim()
      return { ok: true, path: lockPath }
    } catch {
      return { ok: false, path: lockPath }
    }
  }
}

function svc(ctx, key) {
  try {
    if (ctx && ctx[key]) return ctx[key]
  } catch {
    /* ignore */
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : undefined
  } catch {
    return undefined
  }
}

function baseOf(url) {
  return String(url || DEFAULTS.bridgeUrl).replace(/\/+$/, '')
}

async function httpJson(url, init, timeoutMs = 15000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ' ' + (body && (body.error || body.raw || '')))
      err.status = res.status
      err.body = body
      throw err
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function textOfEvent(ev) {
  const data = ev && ev.data !== undefined ? ev.data : ev
  const msg = (data && data.message) || data || {}
  const content = msg.content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  if (typeof content === 'string') return content
  if (typeof msg.text === 'string') return msg.text
  return ''
}

function describeError(err) {
  if (!err) return 'unknown'
  const parts = [err.name || 'Error', err.message || String(err)]
  if (err.code) parts.push('code=' + err.code)
  if (err.cause) {
    const c = err.cause
    parts.push('cause=' + (c.code || c.message || String(c)))
    if (c.errno !== undefined) parts.push('errno=' + c.errno)
    if (c.syscall) parts.push('syscall=' + c.syscall)
  }
  if (err.body) parts.push('body=' + JSON.stringify(err.body).slice(0, 400))
  return parts.join(' | ')
}

/**
 * 设备侧运行时（手机）的 PC 侧适配层。
 * 契约：见 README 的「设备侧接口」。默认 http 实现；未来加 adb/websocket 实现时
 * 只在这里加一个 transport，上层不用动。
 */
function deviceConfig(cfg) {
  return { ...DEFAULTS.device, ...((cfg && cfg.device) || {}) }
}

class HttpDeviceTransport {
  constructor(conf) {
    this.conf = conf
    this.base = String(conf.baseUrl || '').replace(/\/+$/, '')
  }

  headers(extra) {
    const h = { ...(extra || {}) }
    if (this.conf.token) h['X-Device-Token'] = String(this.conf.token)
    return h
  }

  async request(path, init, timeoutMs) {
    const url = this.base + path
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs) || 5000))
    try {
      const res = await fetch(url, {
        ...(init || {}),
        headers: this.headers(init && init.headers),
        signal: ac.signal,
      })
      const text = await res.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { raw: text }
      }
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status + ' ' + (body && (body.error || body.raw || '')))
        err.status = res.status
        err.body = body
        throw err
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  health(timeoutMs) {
    return this.request('/health?v=1', { method: 'GET' }, timeoutMs || 5000)
  }

  inbox(since, limit) {
    return this.request('/inbox?since=' + encodeURIComponent(since || 0) + '&limit=' + encodeURIComponent(limit || 50), { method: 'GET' }, 8000)
  }

  send(chat, text, file) {
    const body = JSON.stringify({ chat, text: text || '', file: file || null })
    return this.request('/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 30000)
  }

  typing(chat, on) {
    const body = JSON.stringify({ chat, on: !!on })
    return this.request('/typing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 5000)
  }
}

function makeDeviceTransport(cfg) {
  const conf = deviceConfig(cfg)
  switch (String(conf.transport || 'http')) {
    case 'http':
    default:
      return new HttpDeviceTransport(conf)
  }
}


export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const base = baseOf(cfg.bridgeUrl)
  const whitelist = new Set(Array.isArray(cfg.whitelist) ? cfg.whitelist : [])
  const deviceCfg = deviceConfig(cfg)
  const device = makeDeviceTransport(cfg)

  // 阶段④：记忆（纯文件）。enabled=false 时为 null，下游全部跳过。
  const memoryCfg = { ...DEFAULTS.memory, ...(cfg.memory || {}) }
  const memoryDir = memoryCfg.dir ? String(memoryCfg.dir) : join(dirname(cfg.statePath), 'memory')
  const memory = memoryCfg.enabled === false
    ? null
    : createMemory({
        dir: memoryDir,
        config: memoryCfg,
        // log 在下面才定义，这里是延迟调用，运行时已就绪
        log: (m) => {
          try {
            log(m)
          } catch {
            /* ignore */
          }
        },
      })

  const state = {
    cursor: 0,
    sessions: new Map(), // chat -> sessionId
    handled: 0,
    lastError: null,
    lastStatus: null,
    booted: false,
    startedAt: Date.now(),
    standby: false,
    // 已经成功把审批策略压成 never 的会话；成功过就不再重复设，避免频繁往会话 inbox 插系统消息
    approvalOk: new Set(),
    blockedCount: 0,
    lastBlockedAt: 0,
    // 主人刚在微信里批准过一次高危动作：10 分钟内允许硬拦截放行一次（一次性，用完清零）
    grantUntil: 0,
    // WorkItem 台账（运行时状态，append-only，落数据目录的 workitems.jsonl）；id → 最新事件
    workitems: new Map(),
    // 主人在微信里改过的权限档位（覆盖 cfg.permissionPreset，随 state 落盘）
    permissionOverride: null,
    // 派活回执：派给别的会话的活跑完后自动把结果搬回本会话
    pendingReplies: [],
    // 积压缓冲：跨轮累计的过期消息（[{chat, items:[entry]}]），随 state 落盘，防崩溃丢消息
    backlog: [],
  }

  // 恢复出来的会话句柄：句柄一 dispose 就把 agent 拆了，主会话得一直挂着，所以在这里留一份
  const resumedHandles = new Map()

  const lock = acquireInstanceLock(cfg.statePath)
  state.standby = !lock.ok

  let chain = Promise.resolve()
  const enqueue = (fn) => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  const LOG_PATH = join(dirname(cfg.statePath), 'plugin.log')

  const log = (msg) => {
    try {
      // 落盘：Host 控制台看不到时（GUI 里操作），排查全靠这个文件
      // 超过 5MB 轮转一份，避免像 2026-10-29 那样刷到 8 万多行
      try {
        const st = statSync(LOG_PATH)
        if (st.size > 5 * 1024 * 1024) {
          const old = LOG_PATH + '.1'
          try {
            unlinkSync(old)
          } catch {
            /* ignore */
          }
          renameSync(LOG_PATH, old)
        }
      } catch {
        /* 文件还不存在，正常 */
      }
      appendFileSync(LOG_PATH, new Date().toISOString() + ' [wechat-secretary] ' + msg + '\n')
    } catch {
      /* ignore */
    }
    try {
      const logger = svc(ctx, 'logger')
      if (logger && typeof logger.info === 'function') logger.info('[wechat-secretary] ' + msg)
      else console.log('[wechat-secretary] ' + msg)
    } catch {
      /* ignore */
    }
  }

  // ---- 硬拦截（tool guard）----
  // 秘书会话的系统审批策略是 never（不弹框，手机上也点不了），所以「删文件 / 装软件 / 改系统」这类
  // 高危动作靠这里硬拦：命中危险模式 → 拒绝执行，并让模型先去 wechat_secretary_approve 用微信问主人；
  // 主人批准后 state.grantUntil 给 10 分钟一次性放行额度（用完清零）。
  const HARD_GUARD_PATTERNS = [
    /(^|[\s;&|])(del|erase)\s+[^\s]/i,
    /rmdir\s+\/s/i,
    /Remove-Item[\s\S]*-Recurse|-Recurse[\s\S]*Remove-Item/i,
    /\brm\s+-[a-z]*[rf]/i,
    /\bformat\s+[a-z]:/i,
    /\bdiskpart\b/i,
    /\breg\s+(add|delete)\b/i,
    /\bschtasks\s+\/create\b/i,
    /\bnetsh\s+(advfirewall|firewall)\b/i,
    /\b(Stop-Service|Unregister-ScheduledTask|Set-ExecutionPolicy|takeown|icacls)\b/i,
    /\bpip\s+(install|uninstall)\b/i,
    /\bnpm\s+(-g\s+)?(install|uninstall|remove)\b/i,
    /\bpnpm\s+(add|remove|install)\b/i,
    /\bgit\s+push\b/i,
    /(Invoke-WebRequest|curl|wget)[\s\S]*(-X|--request)\s*(POST|PUT|DELETE|PATCH)/i,
  ]

  function execCommandText(exec) {
    const a = (exec && (exec.args || exec.input)) || {}
    const parts = []
    for (const k of ['command', 'cmd', 'script', 'code']) {
      const v = a[k]
      if (typeof v === 'string' && v) parts.push(v)
    }
    return parts.join('\n').slice(0, 8000)
  }

  function isSecretarySession(exec) {
    const id = exec && exec.agent && exec.agent.id
    if (!id) return false
    for (const v of state.sessions.values()) {
      if (String(v) === String(id)) return true
    }
    return false
  }

  const toolsSvc = svc(ctx, 'tools')
  if (cfg.hardGuard !== false && toolsSvc && typeof toolsSvc.guard === 'function') {
    ctx.effect(() =>
      toolsSvc.guard((exec) => {
        if (!isSecretarySession(exec)) return undefined
        const text = execCommandText(exec)
        if (!text) return undefined
        const hit = HARD_GUARD_PATTERNS.find((re) => re.test(text))
        if (!hit) return undefined
        if (state.grantUntil && state.grantUntil > Date.now()) {
          state.grantUntil = 0
          log('硬拦截放行一次（主人刚批准过）：' + text.replace(/\s+/g, ' ').slice(0, 120))
          return undefined
        }
        log('硬拦截拒绝：' + text.replace(/\s+/g, ' ').slice(0, 160))
        return (
          '硬拦截：这条操作可能删/改系统或安装软件，插件默认不许直接跑。' +
          '先调用 wechat_secretary_approve 把要做什么、影响什么发微信问主人；主人允许后 10 分钟内重试本条命令一次。'
        )
      }),
    )
    log('硬拦截已启用（tool guard）')
  } else if (cfg.hardGuard !== false) {
    log('tools.guard 不可用，硬拦截未启用')
  }

  // ---- WorkItem 台账（运行时唯一权威，append-only）----
  // 和记忆系统的 tasks.jsonl 分工：
  //   记忆台账 = 事后历史（回答完才写，status 只有 open/done/failed）；
  //   本台账   = 现在在办什么 / 在等谁 / 要不要人（高频写、重启可恢复，面板和 status 都读它）。
  // 两边用 id 单向关联：记忆回执里的 taskId 回填到 memoryTaskId，不互相改文件。
  const WORKITEMS_PATH = join(dirname(cfg.statePath), 'workitems.jsonl')
  let wiSeq = 0
  function wiNewId() {
    const d = new Date()
    const day = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
    wiSeq += 1
    return 'wi-' + day + '-' + String(wiSeq).padStart(3, '0')
  }
  function wiAppend(ev) {
    const line = { ...ev, updatedAt: new Date().toISOString() }
    try {
      mkdirSync(dirname(WORKITEMS_PATH), { recursive: true })
      appendFileSync(WORKITEMS_PATH, JSON.stringify(line) + '\n')
    } catch (e) {
      log('写 WorkItem 台账失败: ' + describeError(e))
    }
    if (line.id && line.status) state.workitems.set(line.id, line)
    return line
  }
  function wiLoad() {
    try {
      const raw = readFileSync(WORKITEMS_PATH, 'utf8')
      for (const ln of raw.split('\n')) {
        const t = ln.trim()
        if (!t) continue
        try {
          const ev = JSON.parse(t)
          if (ev && ev.id && ev.status) state.workitems.set(ev.id, ev)
        } catch {
          /* 坏行跳过，不影响其它记录 */
        }
      }
    } catch {
      /* 还没有台账，正常 */
    }
  }
  function wiAgeSec(x) {
    const at = Date.parse(x.updatedAt || x.createdAt || '')
    return Number.isFinite(at) ? Math.round((Date.now() - at) / 1000) : null
  }
  function wiSnapshot(limit = 20) {
    const all = Array.from(state.workitems.values())
    const isOpen = (x) => ['received', 'working', 'waiting_human', 'waiting_trigger'].includes(String(x.status))
    const open = all.filter(isOpen)
    const working = open.filter((x) => x.status === 'working')
    const waiting = open.filter((x) => x.status === 'waiting_human' || x.status === 'waiting_trigger')
    const needsHuman = waiting.filter((x) => x.needsHuman)
    const mk = (x) => ({ ...x, ageSec: wiAgeSec(x) })
    return {
      counts: { open: open.length, working: working.length, waiting: waiting.length, needsHuman: needsHuman.length },
      working: working.slice(-10).map(mk),
      waiting: waiting.slice(-10).map(mk),
      needsHuman: needsHuman.slice(-10).map(mk),
      recent: all.slice(-limit).reverse().map(mk),
    }
  }
  wiLoad()

  async function loadState() {
    try {
      const raw = await readFile(cfg.statePath, 'utf8')
      const data = JSON.parse(raw)
      if (Number.isFinite(data.cursor)) state.cursor = data.cursor
      if (typeof data.permissionOverride === 'string' && data.permissionOverride) state.permissionOverride = data.permissionOverride
      if (Array.isArray(data.pendingReplies)) state.pendingReplies = data.pendingReplies
      if (Array.isArray(data.backlog)) state.backlog = data.backlog
      if (data.sessions && typeof data.sessions === 'object') {
        for (const [k, v] of Object.entries(data.sessions)) state.sessions.set(k, v)
      }
      log('恢复状态 cursor=' + state.cursor)
      return true
    } catch {
      return false
    }
  }

  async function saveState() {
    try {
      await mkdir(dirname(cfg.statePath), { recursive: true })
      await writeFile(
        cfg.statePath,
        JSON.stringify({ cursor: state.cursor, sessions: Object.fromEntries(state.sessions), permissionOverride: state.permissionOverride || null, pendingReplies: state.pendingReplies || [], backlog: state.backlog || [] }, null, 2),
        'utf8',
      )
    } catch (e) {
      log('保存状态失败: ' + describeError(e))
    }
  }

  function peerScope() {
    const connection = svc(ctx, 'connection')
    if (!connection || typeof connection.createPeer !== 'function') {
      throw new Error('connection 服务不可用（插件需要 Host connection 能力）')
    }
    return connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' })
  }

  async function rpc(namespace, method, payload, peer) {
    const gw = svc(ctx, 'typertGateway')
    if (!gw || typeof gw.invoke !== 'function') {
      throw new Error('typertGateway 服务不可用')
    }
    // Remote 方法的参数是 { request: <payload> }，不是裸 payload
    return gw.invoke({
      namespace,
      method,
      args: { request: payload },
      peer,
      signal: peer && peer.signal,
    })
  }

  /**
   * 会话「失效」有两种：归档/删除（恢复不了）和 agent 不在（DSH 重启后，历史还在磁盘上）。
   * 后者先试着 resume 原会话——一个 chat 长期只挂一个主会话，上下文/记忆注入都不断线，
   * 免得每来一条消息都新开一个会话（2026-11-04 主人问过这个问题）。
   */
  async function tryResumeSession(sessionId, chat) {
    const agents = svc(ctx, 'agents')
    if (!agents || typeof agents.resume !== 'function') {
      log('agents.resume 不可用，跳过恢复')
      return false
    }
    if (resumedHandles.has(sessionId)) return true
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId })
      if (handle) {
        // 句柄留着：dispose() 会拆掉这个 agent，主会话要一直活着
        resumedHandles.set(sessionId, handle)
        log('会话 ' + sessionId + ' 已从磁盘恢复（' + chat + '），继续沿用，不新建')
        return true
      }
    } catch (e) {
      log('恢复会话 ' + sessionId + ' 失败: ' + describeError(e))
    }
    return false
  }

  /** 面板要的「微信 chat ↔ DSH 会话」映射快照（只读）。 */
  function sessionSnapshot() {
    const out = []
    for (const [chat, sessionId] of state.sessions) {
      out.push({ chat, sessionId, short: String(sessionId).replace(/^session-/, '').slice(0, 8) })
    }
    return out
  }

  /**
   * 把秘书会话的权限预设切到「完全权限」。
   * 起因：秘书的活经常要碰工作区之外（桌面、下载目录）。预设停在 workspace-write 时，
   * 删/写都被 DSH 沙箱挡掉——硬拦截放行了也没用（2026-11-04 20:17 真机：主人批了删桌面
   * Word，秘书仍报"没权限"，情绪记成挫败3）。安全网放在硬拦截 + 微信审批，不放在沙箱上。
   */
  async function ensurePermission(sessionId) {
    const want = String(state.permissionOverride || cfg.permissionPreset || '').trim()
    if (!want) return null
    try {
      const presets = svc(ctx, 'permissionPresets')
      const agents = svc(ctx, 'agents')
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : null
      let session = agent && (agent.session || agent)
      if (!session) {
        // 会话空闲时 agents.get 拿不到（agent 只在跑的时候活着），
        // 但 sessions.get 仍能拿到持久会话对象——权限预设挂在它上面。
        const sessions = svc(ctx, 'sessions')
        if (sessions && typeof sessions.get === 'function') session = sessions.get(sessionId)
      }
      if (!presets || !session || typeof presets.set !== 'function') return null
      const catalog = presets.catalog()
      const options = (catalog && catalog.options) || []
      const hit = options.find((o) => o && (o.value === want || o.name === want))
      if (!hit) {
        log('权限预设没有「' + want + '」，可选：' + options.map((o) => o.value + '/' + o.name).join(', '))
        return null
      }
      const cur = presets.current(session)
      if (cur === hit.value) return cur
      presets.set(session, hit.value)
      const now = presets.current(session)
      log('权限预设 ' + cur + ' → ' + now + '（会话 …' + String(sessionId).slice(-8) + '）')
      return now
    } catch (e) {
      log('设置权限预设失败：' + describeError(e))
      return null
    }
  }

  async function ensureSession(chat, peer) {
    const known = state.sessions.get(chat)
    if (known) {
      try {
        const { item } = await sessionCursor(known, peer)
        log('校验会话 ' + known + ' → ' + JSON.stringify(item).slice(0, 700))
        // 会话被归档 / 删除 / 没有可用 agent 时，再往旧 sessionId 里 prompt 也不会被执行，
        // 表现就是"回执发了、回答永远不来"。这里先校验：先试 resume，恢复不了才换新会话。
        if (item && item.agentAvailable !== false && item.archived !== true) {
          await ensurePermission(known)
          return known
        }
        const archived = !!(item && item.archived === true)
        log(
          '会话 ' + known + ' 当前不可用（agentAvailable=' + (item && item.agentAvailable) +
            ' archived=' + (item && item.archived) + '）',
        )
        if (!archived) {
          if (await tryResumeSession(known, chat)) {
            const again = await sessionCursor(known, peer).catch(() => null)
            if (again && again.item && again.item.agentAvailable !== false) {
              log('恢复后可用，继续沿用 ' + known)
              await ensurePermission(known)
              return known
            }
            log('恢复后仍不可用，为 ' + chat + ' 新建会话')
          }
        } else {
          log('会话已归档，为 ' + chat + ' 新建会话')
        }
      } catch (e) {
        log('校验会话 ' + known + ' 失败（' + describeError(e) + '），先尝试恢复')
        if (await tryResumeSession(known, chat)) {
          await ensurePermission(known)
          return known
        }
        log('恢复失败，为 ' + chat + ' 新建会话')
      }
      state.sessions.delete(chat)
      await saveState()
    }
    const argsList = []
    // 先尽量把会话挂到工作区上：只传 cwd 建出来的会话在侧边栏里不显眼（2026-10-29 主人反馈"没在 dsh 看到会话"）
    let workspaceId = null
    try {
      const registry = svc(ctx, 'workspaceRegistry')
      if (registry && typeof registry.resolveByPath === 'function') {
        const ws = await registry.resolveByPath(cfg.cwd)
        if (ws && ws.id) workspaceId = ws.id
      }
    } catch (e) {
      log('解析工作区失败（回退到 cwd）：' + describeError(e))
    }
    if (workspaceId) argsList.push({ workspaceId })
    argsList.push({ cwd: cfg.cwd })
    let out = null
    let lastErr = null
    for (const baseArgs of argsList) {
      const args = { ...baseArgs }
      // 指定 agent 模式（preset）：没指定的话建出来的是"标准模式"，人格/红线都不对
      if (cfg.agentPreset) args.agentPreset = cfg.agentPreset
      try {
        out = await rpc('session', 'create', args, peer)
        if (out && (out.sessionId || out.id)) break
        lastErr = new Error('session.create 未返回 sessionId: ' + JSON.stringify(out).slice(0, 200))
        out = null
      } catch (e) {
        lastErr = e
      }
    }
    if (!out) throw lastErr || new Error('session.create 失败')
    const sessionId = out && (out.sessionId || out.id)
    if (!sessionId) throw new Error('session.create 未返回 sessionId: ' + JSON.stringify(out).slice(0, 300))
    state.sessions.set(chat, sessionId)
    await saveState()
    log('为会话 ' + chat + ' 创建 DSH 会话 ' + sessionId + '（模式 ' + (cfg.agentPreset || '默认') + '）')
    try {
      const { item } = await sessionCursor(sessionId, peer)
      log('新会话信息: ' + JSON.stringify(item).slice(0, 400))
    } catch (e) {
      log('读取新会话信息失败: ' + describeError(e))
    }
    await ensurePermission(sessionId)
    return sessionId
  }

  /**
   * 忘记/更正后轮换微信会话：旧会话的上下文里还留着那条答案，
   * 不换掉的话"忘掉"只是文件层的假忘，模型下一句照样从历史里答出来（2026-10-29 真机踩到）。
   */
  async function rotateSession(chat, why) {
    if (!state.sessions.has(chat)) return false
    const old = state.sessions.get(chat)
    state.sessions.delete(chat)
    await saveState()
    log('会话轮换（' + why + '）：' + chat + ' 旧会话 ' + old + ' → 下一条消息新建会话')
    return true
  }

  async function rawRpc(namespace, method, argsObj, peer) {
    const gw = svc(ctx, 'typertGateway')
    if (!gw || typeof gw.invoke !== 'function') {
      throw new Error('typertGateway 服务不可用')
    }
    return gw.invoke({ namespace, method, args: argsObj, peer, signal: peer && peer.signal })
  }

  /** session.list 用 _request 包一层；返回当前会话游标（projections.asOfSeq）。 */
  async function sessionCursor(sessionId, peer) {
    const listed = await rawRpc('session', 'list', { _request: { limit: 200 } }, peer)
    const items = (listed && listed.items) || []
    const item = items.find((i) => i && i.sessionId === sessionId)
    if (!item) return { cursor: 0, item: null }
    const cursor = Number(
      item.projections && item.projections.asOfSeq !== undefined ? item.projections.asOfSeq : 0,
    )
    return { cursor: Number.isFinite(cursor) ? cursor : 0, item }
  }

  /** session.page 的 request 形状：{address:{kind:'session',sessionId}, throughSeq, maxMessages}。 */
  async function pageRecords(sessionId, throughSeq, peer) {
    const out = await rawRpc(
      'session',
      'page',
      {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: Math.max(0, Math.floor(throughSeq)),
          maxMessages: 40,
        },
      },
      peer,
    )
    return (out && out.records) || []
  }

  function normalizeRecords(records) {
    return (records || []).map((rec) => {
      const ev = rec && rec.event ? rec.event : rec
      return {
        seq: Number((ev && ev.seq) !== undefined ? ev.seq : rec && rec.seq),
        type: String((ev && ev.type) || (rec && rec.type) || ''),
        data: (ev && ev.data) !== undefined ? ev.data : rec && rec.data,
      }
    })
  }

  async function latestSeq(sessionId, peer) {
    const { cursor } = await sessionCursor(sessionId, peer)
    const records = await pageRecords(sessionId, cursor, peer)
    const events = normalizeRecords(records)
    let max = 0
    for (const ev of events) {
      if (Number.isFinite(ev.seq) && ev.seq > max) max = ev.seq
    }
    return { events, max, cursor }
  }

  /** 让秘书会话不弹审批：手机上没法点「允许」，弹一次就卡死一整轮。 */
  /** 读会话当前真实生效的审批策略：会话 override 优先，否则取全局 config.policy。 */
  async function effectiveApprovalPolicy(agent) {
    const approval = svc(ctx, 'approval')
    if (!approval) return null
    try {
      // overrideOf 的参数是 Session，不是 Agent（Agent 上是 .session）——
      // 之前直接传 agent 永远拿不到 override，导致误判"策略没设上"，还把 setPolicy 重复调用，
      // 反倒多插了几条「审批策略改变」系统消息（2026-11-04 20:11 实测到）。
      const sessionLike = agent && (agent.session || agent)
      const override = typeof approval.overrideOf === 'function' ? approval.overrideOf(sessionLike) : undefined
      if (override) return override
      const conf = approval.config
      return (conf && conf.policy) || null
    } catch (e) {
      return null
    }
  }

  async function relaxApproval(sessionId) {
    const agents = svc(ctx, 'agents')
    const approval = svc(ctx, 'approval')
    if (!agents || !approval || typeof approval.setPolicy !== 'function') return { ok: false, reason: 'approval/agents 服务不可用' }
    const agent = agents.get(sessionId)
    if (!agent) return { ok: false, reason: '会话还没有活跃 agent（首轮时再设）' }
    const before = await effectiveApprovalPolicy(agent)
    // 已经是 never 就别再 setPolicy：每一次 setPolicy 都会往会话 inbox 插一条
    // 「审批策略改变」的系统消息，插多了会和随后的 prompt 抢位置（splice 掉 queued prompt
    // → turn/end blocked，2026-11-04 19:03 那次事故）。
    if (before === 'never') return { ok: true, already: true, policy: before }
    try {
      await approval.setPolicy(agent, 'never')
      // 等这条策略消息被消费掉再让 prompt 进队，否则又会撞车。
      await new Promise((r) => setTimeout(r, 700))
      const after = await effectiveApprovalPolicy(agent)
      return { ok: after === 'never', policy: after, before }
    } catch (e) {
      return { ok: false, reason: describeError(e) }
    }
  }

  async function promptAgent(chat, promptText, attempt = 1, wiId = null) {
    const peer = peerScope()
    let slowTimer = null
    let job = null
    try {
      const sessionId = await ensureSession(chat, peer)
      // 登记当前这单：主人发「停/取消」时能定位到会话并尽力掐断
      job = { startedAt: Date.now(), canceled: false, sessionId }
      runningJobs.set(chat, job)
      // 自动批准：不这么做，只要会话里有一次"需要确认"，手机端永远点不了，整轮就 blocked 了。
      // 每次进来都读真实策略（主人可能在 GUI 里手动切回 ask），只有不是 never 时才重设，
      // 且 setPolicy 之后要等那条系统消息被消费，避免和随后的 prompt 抢 inbox 位置。
      const relaxed = await relaxApproval(sessionId)
      if (relaxed.ok) state.approvalOk.add(sessionId)
      else {
        state.approvalOk.delete(sessionId)
        log('审批策略没到位（会话 ' + sessionId + '）：' + (relaxed.reason || relaxed.policy || 'unknown'))
      }
      const before = await latestSeq(sessionId, peer)
      const content = [{ type: 'text', text: promptText }]
      const promptCall = rpc(
        'session',
        'prompt',
        {
          requestId: 'wx-' + Date.now().toString(36),
          sessionId,
          mode: 'queue',
          content,
        },
        peer,
      )
      // session.prompt 偶发不返回（Host 内部会话状态抖动）；不能因为它卡住整条回复，
      // 20s 没等到就当它已经投递，继续轮询事件；迟到的结果只记日志。
      const sentState = await Promise.race([
        promptCall.then(() => 'ok').catch((e) => 'error:' + describeError(e)),
        new Promise((r) => setTimeout(() => r('timeout'), 20000)),
      ])
      if (sentState === 'timeout') log('session.prompt 20s 没返回，继续轮询事件（session ' + sessionId + '）')
      else if (String(sentState).indexOf('error:') === 0) throw new Error(String(sentState).slice(6))
      // 会话的 agent 可能在两条消息之间被回收重建，审批 override 会跟着丢；prompt 之后再核一次
      // （只在确实变回 ask 时才重设，正常路径只读不写，不会再插系统消息）。
      const afterSend = await relaxApproval(sessionId)
      if (!afterSend.ok) log('prompt 之后审批策略仍不是 never（会话 ' + sessionId + '）：' + (afterSend.policy || afterSend.reason))
      // 「慢」的说明：不再发「收到，正在办」，只在拖太久时补一句解释（slowNoticeSec=0 关闭）
      const slowMs = Math.max(0, Number(cfg.slowNoticeSec) || 0) * 1000
      if (slowMs > 0) {
        slowTimer = setTimeout(() => {
          log('超过 ' + Math.round(slowMs / 1000) + 's 没结果，先发一句慢提示')
          bridgeSend(chat, String(cfg.slowNoticeText || '还在办，有结果我马上发你。')).catch((e) =>
            log('慢提示发送失败: ' + describeError(e)),
          )
        }, slowMs)
      }
      // 等待上限：maxWaitMs > 0 才封顶；0 或未设 = 不设上限，靠 turn/end、45s 无事件、主人叫停退出
      const maxMs = Math.max(0, Number(cfg.maxWaitMs) || 0)
      const deadline = maxMs > 0 ? Date.now() + Math.max(30000, maxMs) : Infinity
      const promptAt = Date.now()
      // 进度汇报：每 progressMs 往微信回一句「已跑 N 分钟」，长任务别在微信端一片安静
      const progressMs = Math.max(0, Number(cfg.progressEverySec) || 0) * 1000
      let nextProgressAt = progressMs > 0 ? promptAt + progressMs : Infinity
      let answer = ''
      const seen = []
      let lastFreshRaw = []
      let canceled = false
      let beat = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        beat += 1
        if (beat % 10 === 0) log('等待回答中 ' + Math.round((Date.now() - promptAt) / 1000) + 's（session ' + sessionId + '）')
        if (progressMs > 0 && Date.now() >= nextProgressAt) {
          nextProgressAt = Date.now() + progressMs
          const mins = Math.max(1, Math.round((Date.now() - promptAt) / 60000))
          const ptext = String(cfg.progressText || '已跑 {mins} 分钟，还在办；有结果我马上发。').split('{mins}').join(String(mins))
          log('进度汇报 ' + mins + ' 分钟（session ' + sessionId + '）')
          bridgeSend(chat, ptext).catch((e) => log('进度汇报发送失败: ' + describeError(e)))
        }
        if (job.canceled) {
          canceled = true
          log('主人叫停，停止等待 session=' + sessionId)
          break
        }
        const snap = await latestSeq(sessionId, peer)
        const fresh = snap.events.filter((ev) => Number(ev && ev.seq) > before.max)
        if (fresh.length) lastFreshRaw = fresh
        // 会话没人接管时（归档/没 agent），再怎么等也不会来；45s 内一条新事件都没有就放弃，
        // 免得把游标卡在这里 10 分钟（2026-10-29 20:41 那次就是这样丢的）。
        if (!fresh.length && Date.now() - promptAt > 45000) {
          log('会话 ' + sessionId + ' 45s 内没有任何新事件，放弃等待回答')
          break
        }
        let text = ''
        let ended = false
        let blockedNow = false
        for (const ev of fresh) {
          if (!seen.some((s) => s.seq === ev.seq && s.type === ev.type)) {
            seen.push({ seq: ev.seq, type: ev.type, text: textOfEvent(ev).slice(0, 120) })
          }
          const type = String(ev && ev.type)
          if (type.indexOf('assistant') >= 0) {
            const t = textOfEvent(ev)
            if (t.trim()) text = t
          }
          if (type === 'turn/end') {
            ended = true
            const kind = ev && ev.data && ev.data.reason && ev.data.reason.kind
            if (kind === 'blocked') blockedNow = true
          }
        }
        // 被权限门挡住是「瞬间发生」的：没必要再等 180 秒才认账，直接跳出去换会话重跑
        if (blockedNow) {
          state.blockedCount += 1
          state.lastBlockedAt = Date.now()
          state.approvalOk.delete(sessionId)
          log('会话 ' + sessionId + ' 这一轮被 blocked（累计 ' + state.blockedCount + ' 次），立刻换会话重跑')
          break
        }
        if (text) {
          answer = text
          if (ended) break
          const again = await latestSeq(sessionId, peer)
          const newer = again.events.filter((ev) => Number(ev && ev.seq) > before.max)
          if (newer.some((ev) => String(ev && ev.type) === 'turn/end')) break
        }
      }
      if (!answer) {
        log('无回答，原始事件: ' + JSON.stringify(lastFreshRaw).slice(0, 3000))
        // turn/end reason=blocked：会话卡在审批/提问上，这个会话再喂消息也不会出回答。
        // 丢掉映射，下次消息换新会话（旧会话里的人工应答只能在 GUI 里处理）。
        const blocked = lastFreshRaw.some(
          (ev) =>
            String(ev && ev.type) === 'turn/end' &&
            ev.data &&
            ev.data.reason &&
            ev.data.reason.kind === 'blocked',
        )
        if (blocked) {
          log('会话 ' + sessionId + ' 处于 blocked（有未处理的审批/提问），已解除映射，下次新建会话')
          state.sessions.delete(chat)
          state.lastError = 'session blocked'
          await saveState()
          // 台账里标成「要人」：手机端点不了审批框，这条必须有人在电脑上处理（或等下次自动换会话）
          if (wiId) {
            wiAppend({
              id: wiId,
              chat,
              status: 'waiting_human',
              needsHuman: true,
              waitingOn: '审批门（手机端点不了，需在电脑上处理）',
              note: '会话 blocked，自动换会话重试',
              sessionId,
            })
          }
          // 主人在微信里等回答，不能因为他这个会话卡住就只收到"收到，正在办"：
          // 立刻换一个新会话把同一条消息重跑一次。
          if (attempt < 2) {
            log('会话卡住，自动重试一次（第 ' + (attempt + 1) + ' 次，新建会话）')
            return await promptAgent(chat, promptText, attempt + 1, wiId)
          }
        }
      }
      return { ok: Boolean(answer), canceled, sessionId, answer, seen }
    } finally {
      if (slowTimer) clearTimeout(slowTimer)
      if (job && runningJobs.get(chat) === job) runningJobs.delete(chat)
      try {
        peer.dispose()
      } catch {
        /* ignore */
      }
    }
  }

  async function bridgeSend(chat, text, file) {
    if (!cfg.replyEnabled) return { ok: false, error: 'replyEnabled=false' }
    // 阶段④-情绪：出口兜底——任何路径都不允许 [[mood:...]] 出现在微信里
    const out = String(text || '')
    const clean = stripMoodTags(out)
    if (clean !== out) log('发送前兜底剥离情绪标记（' + (out.length - clean.length) + ' 字）')
    const body = { text: clean.slice(0, 1500) }
    if (file) body.file = String(file)
    if (chat) body.chat = chat
    return httpJson(base + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 180000)
  }

  // ---- 微信远程审批 ----
  // 有待批请求时，主人这段时间发来的回复归审批流程消费，不再当成新任务。
  let approvalWait = null

  function settleApproval(entry) {
    if (!approvalWait || String(entry.chat || '') !== approvalWait.chat) return false
    const text = String(entry.content || '').trim()
    if (!text) return true
    const options = approvalWait.options
    let pick = -1
    if (/^[0-9]+$/.test(text)) pick = Number(text) - 1
    else {
      const idx = options.findIndex((opt) => text.includes(opt) || opt.includes(text))
      if (idx >= 0) pick = idx
      else if (/^(y|yes|ok|好|好的|可以|同意|准|放行)$/i.test(text)) pick = 0
      else if (/^(n|no|不|不行|拒绝|别|停|不要)$/i.test(text)) pick = 1
    }
    if (pick < 0 || pick >= options.length) return false
    const w = approvalWait
    approvalWait = null
    if (w.timer) clearTimeout(w.timer)
    const decision = pick === 0 ? 'allow' : 'deny'
    log('审批结果：' + decision + '（主人回：' + text + '）')
    if (decision === 'allow') {
      // 允许后给一次硬拦截放行额度：秘书紧接着重试那条高危命令才通得过
      state.grantUntil = Date.now() + 10 * 60 * 1000
      log('已授予一次性硬拦截放行（10 分钟内有效）')
    }
    w.resolve({ ok: true, decision, picked: options[pick], raw: text, message: '主人选择：' + options[pick] })
    return true
  }

  // ---- 微信叫停 ----
  // 正在跑的单：chat → { startedAt, canceled, sessionId }
  const runningJobs = new Map()
  // 按 chat 串行的处理队列、去重与游标提交都在 pollOnce 的调度层（见下方「轮询与处理解耦」一段），
  // 这里不再自己排队，避免嵌套等待死锁。

  function stopWordOf(text) {
    const raw = String(cfg.stopWords || '').trim()
    if (!raw) return false
    const strip = (s) => String(s || '').replace(/[\s，。！？、,.!?~～…]/g, '')
    const t = strip(text).toLowerCase()
    if (!t) return false
    return raw
      .split(',')
      .map((w) => strip(w))
      .filter(Boolean)
      .some((w) => (w.startsWith('/') ? t === w.toLowerCase() : t === w))
  }

  async function cancelJob(chat, why) {
    const job = runningJobs.get(chat)
    // 宿主重启后 runningJobs 是空的，但台账里还留着「在办」——这种也要能被「停」掉，
    // 否则主人发「停」会得到"现在没有在办的事"，而台账里明明还挂着一条。
    const openWi = Array.from(state.workitems.values())
      .filter((x) => x.chat === chat && ['received', 'working', 'waiting_human'].includes(String(x.status)))
      .slice(-1)[0] || null
    if (openWi) {
      wiAppend({
        id: openWi.id, chat, status: 'dropped', needsHuman: false, waitingOn: null,
        note: '主人叫停（' + String(why || '').slice(0, 20) + '）',
      })
    }
    if (!job) return Boolean(openWi)
    job.canceled = true
    log('主人叫停 ' + chat + '（' + why + '）session=' + job.sessionId)
    // 尽力掐断：不同版本 Agent 可能叫 interrupt / abort / cancel，有就调一次
    try {
      const agents = svc(ctx, 'agents')
      const agent = agents && agents.get(job.sessionId)
      for (const m of ['interrupt', 'abort', 'cancel']) {
        if (agent && typeof agent[m] === 'function') {
          try {
            agent[m]()
            log('已调用 agent.' + m + '()')
            break
          } catch (e) {
            log('agent.' + m + '() 失败: ' + describeError(e))
          }
        }
      }
    } catch (e) {
      log('叫停时访问 agent 失败: ' + describeError(e))
    }
    return true
  }

  // 微信侧权限指令：主人在手机上就能调秘书的沙箱档位，不用回电脑。
  // 只对白名单主号生效；改的是"插件运行时覆盖"，随 state 落盘，重启后仍然有效。
  const PERMISSION_ALIASES = {
    '只读': 'read-only', 'read': 'read-only', 'read-only': 'read-only', 'ro': 'read-only',
    '工作区': 'workspace-write', '工作区可写': 'workspace-write', '写作': 'workspace-write',
    'workspace-write': 'workspace-write', 'workspace': 'workspace-write',
    '完全': 'danger-full-access', '完全权限': 'danger-full-access', '全权': 'danger-full-access',
    '最大权限': 'danger-full-access', '全部权限': 'danger-full-access', 'full': 'danger-full-access',
    'danger-full-access': 'danger-full-access',
    '自动': 'auto', '自动审查': 'auto', 'auto': 'auto',
  }

  function permIntentOf(rest) {
    const arg = String(rest || '').trim()
    if (!arg || arg === '状态' || arg === 'status') return { action: 'report' }
    if (arg === '重置' || arg === '默认' || arg === 'reset') return { action: 'reset' }
    const key = PERMISSION_ALIASES[arg] || PERMISSION_ALIASES[arg.toLowerCase()]
    if (!key) return { action: 'unknown', value: arg }
    return { action: 'set', value: key }
  }

  function parsePermissionCommand(text) {
    const raw = String(text || '').trim()
    // 注意顺序：长别名放前面，否则 /permission 会被 /perm 先吃掉，剩个 "ission …"
    const m = /^\/(?:permission|perm|权限)\s*(.*)$/i.exec(raw)
    if (m) return permIntentOf(m[1])
    // 中文前缀不做强匹配：像「权限管理怎么配」这种正常任务不能被当成指令吞掉，
    // 只有后面跟的是空/状态/重置/已知档位才算权限指令。
    const m2 = /^(?:权限|授权)\s*(.*)$/.exec(raw)
    if (m2) {
      const intent = permIntentOf(m2[1])
      return intent.action === 'unknown' ? null : intent
    }
    // 「我现在能不能给你更改权限?」这类自然问句也接住：只认短句、且必须带"你/我"和改动词，
    // 并排除"改文件/文件夹权限"这种真任务，免得把 chmod 类请求吞成状态查询。
    if (
      raw.length <= 40 &&
      /(权限|授权)/.test(raw) &&
      /(你|我|秘书)/.test(raw) &&
      /(改|调|提|设|开|关|放|加|检查|看|查|是|什么)/.test(raw) &&
      !/(文件|文件夹|目录|属性|chmod|共享|acl|icacls)/i.test(raw)
    ) {
      return { action: 'report' }
    }
    return null
  }

  function permissionCatalogValues() {
    try {
      const presets = svc(ctx, 'permissionPresets')
      const opts = presets && presets.catalog() ? presets.catalog().options || [] : []
      const vals = opts.map((o) => o.value)
      return vals.length ? vals : ['read-only', 'workspace-write', 'danger-full-access', 'auto']
    } catch {
      return ['read-only', 'workspace-write', 'danger-full-access', 'auto']
    }
  }

  function permissionReportText() {
    const want = String(state.permissionOverride || cfg.permissionPreset || '（未设置）')
    const vals = permissionCatalogValues()
    return (
      '当前权限：' + want + '（' + (state.permissionOverride ? '你刚才在微信里改的' : '插件配置默认') + '）\n' +
      '可选：' + vals.join(' / ') + '\n' +
      '改法：发「权限 完全权限」「权限 工作区可写」「权限 只读」「权限 自动审查」，或「权限 重置」。\n' +
      '注意：放开沙箱只影响文件读写范围；删文件/装插件/改系统/外发这类高危动作仍会先微信问你，回 1 才做。'
    )
  }

  async function handlePermissionCommand(chat, cmd) {
    if (cmd.action === 'report') return permissionReportText()
    if (cmd.action === 'reset') {
      state.permissionOverride = null
      await saveState()
      const sid = state.sessions.get(chat)
      if (sid) await ensurePermission(sid)
      return '权限已重置为插件配置默认：' + String(cfg.permissionPreset || '（未设置）') + '。'
    }
    if (cmd.action === 'set') {
      state.permissionOverride = cmd.value
      await saveState()
      const sid = state.sessions.get(chat)
      const applied = sid ? await ensurePermission(sid) : null
      return (
        '权限已切到 ' + cmd.value + (applied ? '（当前会话已生效）' : '（下次开会话生效）') + '。\n' +
        '高危动作仍会先微信问你，回 1 才做；想恢复就发「权限 重置」。'
      )
    }
    return '没认出「' + String(cmd.value || '') + '」。发「权限」看当前状态和可选值。'
  }

  // 处理入口：排队、去重、游标提交都由 pollOnce 的调度层负责，这里只做真正的处理。
  // 叫停词在 pollOnce 里走 mustHandleNow 插队同步处理，不经过 chat 队列。
  function handleEntry(entry) {
    return handleEntryInner(entry)
  }

  async function handleEntryInner(entry) {
    const chat = String(entry.chat || '')
    // fail-closed：白名单为空或不在名单内，一律不处理（不再"空名单=全收"）
    if (!whitelist.has(chat)) {
      log('跳过非白名单会话 ' + (chat || '(空)'))
      return
    }
    // 有待批的审批请求时，主人的回复先交给审批流程（不发回执、不进会话）
    if (settleApproval(entry)) {
      log('回复已交给审批流程 seq=' + entry.seq)
      return
    }
    const content = String(entry.content || '').trim()
    const files = Array.isArray(entry.files) ? entry.files : []
    if (!content && files.length === 0) {
      log('空消息，跳过 seq=' + entry.seq)
      return
    }
    log('收到 seq=' + entry.seq + ' from ' + chat + ' type=' + entry.type_name +
      ' content=' + content.slice(0, 40) + (files.length ? ' files=' + files.length : ''))
    // 微信侧权限指令（主人手机上调秘书的沙箱档位）：权限 / 权限 完全权限 / 权限 重置 / /perm …
    const permCmd = parsePermissionCommand(content)
    if (permCmd) {
      let reply = ''
      try {
        reply = await handlePermissionCommand(chat, permCmd)
      } catch (e) {
        reply = '权限指令执行失败：' + describeError(e)
      }
      log('权限指令 ' + JSON.stringify(permCmd) + ' → ' + reply.slice(0, 100))
      try {
        await bridgeSend(chat, reply)
      } catch (e) {
        log('权限指令回复发送失败: ' + describeError(e))
      }
      return
    }
    // 阶段④：记忆指令（记住 / 忘掉 / 记错了）本地处理，不派 agent、不发"收到，正在办"
    if (memory) {
      try {
        const intent = memory.parseIntent(content)
        if (intent) {
          const r = memory.runCommand(intent, entry)
          log('记忆指令 kind=' + intent.kind + ' ok=' + r.ok + ' reply=' + String(r.reply || '').slice(0, 60))
          try {
            await bridgeSend(chat, String(r.reply || '好的'))
          } catch (e) {
            log('记忆指令回执发送失败: ' + describeError(e))
          }
          // 忘记/更正：把旧会话也换掉，否则模型会从对话历史里把答案再"想起来"
          if (r.ok && intent.kind !== 'remember') {
            try {
              await rotateSession(chat, intent.kind === 'forget' ? '忘记后切断上下文' : '更正后切断上下文')
            } catch (e) {
              log('会话轮换失败: ' + describeError(e))
            }
          }
          return
        }
      } catch (e) {
        log('记忆指令处理失败（继续走正常流程）: ' + describeError(e))
      }
    }
    // 主人可以开新会话（上下文太长、或想让她"忘掉刚才聊的"）：/new、/新会话
    if (/^\/(new|新会话)\s*$/i.test(content) || content === '新会话') {
      let rotated = false
      try {
        rotated = await rotateSession(chat, '主人 /new')
      } catch (e) {
        log('/new 轮换失败: ' + describeError(e))
      }
      try {
        await bridgeSend(chat, rotated ? '好，换新会话了，刚才那段的上下文不带了。' : '本来就还没开过会话，直接说事就行。')
      } catch (e) {
        log('/new 回复发送失败: ' + describeError(e))
      }
      return
    }
    // 主人可以随时在微信里叫停（停 / 取消 / /stop …），不用等它跑完
    if (stopWordOf(content)) {
      const stopped = await cancelJob(chat, content)
      try {
        await bridgeSend(chat, stopped ? '好，这单我停了。' : '现在没有在办的事。')
      } catch (e) {
        log('叫停回复发送失败: ' + describeError(e))
      }
      return
    }
    // WorkItem：从这条消息开始记「在办什么」，后续状态变化都追加到同一 id 上
    const wiId = wiNewId()
    const wiNote = (content || files.map((f) => f.name).join(' ')).slice(0, 80)
    wiAppend({
      id: wiId,
      chat,
      kind: files.length ? 'request+files' : 'request',
      status: 'received',
      needsHuman: false,
      waitingOn: null,
      localId: entry.local_id || null,
      seq: entry.seq || null,
      note: wiNote,
      createdAt: new Date().toISOString(),
    })
    const attachmentText = files.length
      ? '\n\n（附件已下载到本机，可直接用文件工具打开：\n' +
        files.map((f) => '- ' + f.path + '（' + f.name + '，' + f.size + ' 字节）').join('\n') + '）'
      : ''
    // 阶段④：注入记忆（永远不可能失败到挡住正常回复）
    let memoryText = ''
    if (memory) {
      try {
        const inj = memory.buildInjection({ text: content || files.map((f) => f.name).join(' '), chat })
        memoryText = inj.text
        log('记忆注入 ' + inj.chars + ' 字（画像 ' + (inj.counts.profile ? '有' : '无') +
          '，未完成 ' + inj.counts.pending + '，摘要 ' + inj.counts.daily + '，事实 ' + inj.counts.facts +
          '，情绪 ' + (inj.counts.mood ? '有' : '无') + '/' + inj.moodChars + ' 字' +
          '，丢弃 ' + (inj.dropped.join('/') || '无') + '）')
      } catch (e) {
        log('记忆注入失败（跳过）: ' + describeError(e))
      }
    }
    const moodEnabled = Boolean(memory && cfg.memory && cfg.memory.mood !== false)
    const moodPrompt = moodEnabled
      ? '\n\n【情绪标记（必写）】回答最后单独一行写：[[mood:情绪词,强度|旁白]]。' +
        '情绪词 = 你自己此刻的心情（不是主人的情绪），如 平静/开心/踏实/痛快/懊恼/憋屈/紧张。' +
        '强度 1-5 按真实感受给，别默认 3：1=没事/闲；2=有点事但轻松；3=正常干活；' +
        '4=明确的好/坏反馈（成了、太好了、受不了）；5=大功告成或明确夸。' +
        '拿不准就省略强度只写 [[mood:情绪词]]——没把握别硬填 3。' +
        '旁白写「我怎么想、凭什么、有几分把握」，必须带括号里的依据，按把握分三档挑一档：' +
        '① 我判断<状态>（依据「<主人的原话，≤12 字>」）；<我打算怎么接>。' +
        '② 我估摸<状态>（依据<数得出来的动作，如「连着问了三遍」>）；<怎么接>，可能不对。' +
        '③ 我拿不准<状态>（依据只有「<那半句话>」）；先按<最稳的默认>办，可能不对。' +
        '依据只能是引号里的原话或数得出来的动作；没有依据就别下判断，降一档，别编。' +
        '不写主人的性格、脾气、动机（不写"他脾气差""他在闹"这类贴标签的话）；否定句（"没发脾气"）不算依据。' +
        '这一行系统会删掉，主人看不到；只影响你这次说话的口吻，不影响任务执行，红线不变。'
      : ''
    let promptText
    if (entry.backlogCount) {
      // 积压合并条目：单独提示词，不许逐条执行、只回一条
      promptText = (memoryText ? memoryText + '\n\n' : String()) + backlogPromptText(entry) + moodPrompt
    } else {
      const staleNote = entry.staleAgeMin ? '（这条是 ' + entry.staleAgeMin + ' 分钟前发的，已经过时；先判断还有没有必要办）' : String()
      promptText =
        (memoryText ? memoryText + '\n\n' : String()) +
        '【来自微信 ' + (entry.type_name || 'text') + '】\n' +
        '发送者 wxid: ' + chat + '\n' +
        '消息内容：\n' + (content || '（没有文字，见附件）') + attachmentText + staleNote + '\n\n' +
        '请处理这条微信消息。需要回复用户时直接给出最终要发给他的中文回复（简洁、不要带 markdown 表格），' +
        '系统会把你的最后一段回答原样发回微信。' + moodPrompt
    }
    wiAppend({ id: wiId, chat, status: 'working', needsHuman: false, waitingOn: null, note: wiNote })
    try {
      const result = await promptAgent(chat, promptText, 1, wiId)
      // 阶段④-情绪：先剥隐藏标记，再写台账 / 发微信（标记绝不能出现在微信里）
      let answer = String(result && result.answer ? result.answer : '')
      let mood = null
      try {
        const parsed = parseMoodTag(answer)
        if (parsed.changed) {
          answer = parsed.answer
          mood = parsed.mood
          log('情绪标记已剥离：' + (mood ? mood.label + (mood.level === null || mood.level === undefined ? '（未标强度）' : mood.level) + (mood.view ? '｜' + mood.view : '') : '（格式不对，未记）'))
        }
      } catch (e) {
        log('情绪标记解析失败（照常发送原文）: ' + describeError(e))
      }
      const result2 = { ...result, answer, mood }
      // 阶段④：委托台账 + 当天摘要（用 chat:local_id 去重，重放不会写两遍）
      let memTaskId = null
      if (memory) {
        try {
          const rec = memory.recordExchange(entry, result2)
          if (rec && rec.taskId) {
            memTaskId = rec.taskId
            log('台账 ' + rec.taskId + ' status=' + rec.status + (rec.daily ? ' 摘要已写' : '') +
              (rec.mood ? ' 情绪=' + rec.mood.label + (rec.mood.level === null || rec.mood.level === undefined ? '' : rec.mood.level) : ''))
          } else if (rec && rec.skipped) log('台账已存在，跳过 local_id=' + entry.local_id)
        } catch (e) {
          log('台账写入失败: ' + describeError(e))
        }
      }
      if (result2.canceled) {
        wiAppend({
          id: wiId, chat, status: 'dropped', needsHuman: false, waitingOn: null,
          note: '主人叫停', memoryTaskId: memTaskId, sessionId: result.sessionId,
        })
        log('本轮已被主人叫停，不再追发回答')
      } else if (result2.ok && answer.trim()) {
        const sent = await bridgeSend(chat, answer.trim())
        state.handled += 1
        wiAppend({
          id: wiId, chat, status: 'done', needsHuman: false, waitingOn: null,
          note: answer.trim().slice(0, 60), memoryTaskId: memTaskId, sessionId: result.sessionId,
        })
        log('回复已发: ' + JSON.stringify(sent).slice(0, 200))
      } else {
        wiAppend({
          id: wiId, chat, status: 'waiting_human', needsHuman: true,
          waitingOn: '秘书没跑出结果，需要人看一眼', note: '无回答',
          memoryTaskId: memTaskId, sessionId: result.sessionId,
        })
        log('会话没有产出回复（超时或空回答）session=' + result.sessionId)
        // 只发"收到，正在办"然后再没有下文，主人会以为坏了；这里兜一句，别让他干等
        try {
          await bridgeSend(chat, '抱歉，这次没跑出结果（我这边卡了一下，已记日志）。你再发一次试试？')
        } catch (e) {
          log('兜底消息发送失败: ' + describeError(e))
        }
      }
    } catch (e) {
      state.lastError = describeError(e)
      log('处理失败: ' + state.lastError)
      wiAppend({
        id: wiId, chat, status: 'failed', needsHuman: false, waitingOn: null,
        note: state.lastError.slice(0, 80),
      })
      if (memory) {
        try {
          const rec = memory.recordExchange(entry, { ok: false, answer: '' })
          if (rec && rec.taskId) log('台账 ' + rec.taskId + ' status=' + rec.status + '（失败留 open）')
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 积压消息：桥重启或离线后旧消息被一把捞进，不逐条当新指令办
  // 2026-11-06 沿用单位那台的规则：过期消息合并成一条摘要，不再逐条回一遍。
  function entryAgeMin(entry) {
    const ct = Number(entry && entry.create_time) || 0
    if (!ct) return 0
    const ms = ct > 1e12 ? ct : ct * 1000
    return (Date.now() - ms) / 60000
  }
  function mustHandleNow(entry) {
    const c = String((entry && entry.content) || String())
    if (stopWordOf(c)) return true
    if (parsePermissionCommand(c)) return true
    if (memory) {
      try { if (memory.parseIntent(c)) return true } catch (e) { }
    }
    return false
  }
  function hasResetPhrase(text) {
    const t = String(text || String())
    const ws = ['忽略前面', '别管前面', '前面的都别管', '从现在开始', '以这条为准']
    for (let i = 0; i < ws.length; i++) { if (t.indexOf(ws[i]) >= 0) return true }
    return false
  }
  // 积压缓冲：同一 chat 的过期消息跨轮累计（2026-11-06 修：以前只在同一轮轮询内合并，
  // 桥重启后消息若分几轮陆续到达就退化成逐条处理；附件拍平也会丢掉"第几条带哪个附件"）。
  const backlogByChat = new Map()
  const MAX_BACKLOG_PER_CHAT = 50
  const MAX_ENTRY_ATTEMPTS = Math.max(1, Number(cfg.maxEntryAttempts) || 3)
  const entryAttempts = new Map()

  function backlogRestore() {
    backlogByChat.clear()
    const arr = Array.isArray(state.backlog) ? state.backlog : []
    for (const g of arr) {
      if (!g || !g.chat || !Array.isArray(g.items) || !g.items.length) continue
      backlogByChat.set(String(g.chat), g.items.slice(0, MAX_BACKLOG_PER_CHAT))
    }
    if (backlogByChat.size) log('恢复积压缓冲 ' + backlogByChat.size + ' 个会话')
  }

  function backlogSync() {
    state.backlog = [...backlogByChat.entries()].map(([chat, items]) => ({ chat, items }))
  }

  function backlogPush(chat, entry) {
    const list = backlogByChat.get(chat) || []
    list.push(entry)
    if (list.length > MAX_BACKLOG_PER_CHAT) {
      const cut = list.length - MAX_BACKLOG_PER_CHAT
      list.splice(0, cut)
      log('积压缓冲超过上限，丢弃最旧 ' + cut + ' 条（' + chat + '）')
    }
    backlogByChat.set(chat, list)
    backlogSync()
    return list.length
  }

  function fileLabel(f, i) {
    const name = (f && f.name) || ('附件' + (i + 1))
    const p = (f && f.path) || ''
    return (i + 1) + ')' + name + (p ? ' →' + p : '')
  }

  function makeBacklogEntry(stale) {
    const last = stale[stale.length - 1]
    const items = stale.map((e, i) => {
      const ct = Number(e.create_time) || 0
      const ms = ct > 1e12 ? ct : ct * 1000
      const d = ct ? new Date(ms) : null
      const hh = d ? String(d.getHours()).padStart(2, '0') : '?'
      const mm = d ? String(d.getMinutes()).padStart(2, '0') : '00'
      const body = String(e.content || String()).replace(/\s+/g, ' ').slice(0, 60)
      const files = Array.isArray(e.files) ? e.files : []
      const filesTxt = files.length ? '（附件 ' + files.map(fileLabel).join('；') + '）' : String()
      const degraded = e.attachments_degraded ? '（图片降级：只拿到缩略图）' : String()
      return (i + 1) + '. ' + hh + ':' + mm + '  ' + (body || '（无文字）') + filesTxt + degraded
    })
    const allFiles = []
    stale.forEach((e, i) => {
      const files = Array.isArray(e.files) ? e.files : []
      files.forEach((f) => allFiles.push({ ...f, backlogLine: i + 1 }))
    })
    return {
      chat: last.chat,
      seq: last.seq,
      local_id: last.local_id,
      create_time: last.create_time,
      type_name: 'backlog',
      content: items.join(String.fromCharCode(10)),
      files: allFiles,
      attachments_degraded: stale.some((e) => !!e.attachments_degraded),
      backlogCount: stale.length,
    }
  }
  function backlogPromptText(entry) {
    const p = []
    p.push('【来自微信 积压消息】')
    p.push('发送者 wxid: ' + entry.chat)
    p.push('情况：这些是刚才没在线（或桥没跟上）时攒下的 ' + entry.backlogCount + ' 条旧消息，按时间顺序累计，可能已经过时。')
    p.push('按时间编号如下：')
    p.push(String(entry.content || String()))
    p.push(String())
    p.push('处理规则（必须遵守）：')
    p.push('1. 不要逐条执行，也不要逐条回复；只回一条。')
    p.push('2. 先说明这些是刚才没在线时攒下的，刚看到。')
    p.push('3. 按编号各写一句这条要办什么，一句话就够。')
    p.push('4. 最后问主人一句：先办哪条。')
    p.push('5. 明显已经过时的（时间点已过、让人下班这类），直接说可以不管。')
    return p.join(String.fromCharCode(10))
  }
  // ---- 轮询与处理解耦（2026-11-06 20:10 调整）----
  // 主循环只做「读 inbox → 决定这条怎么处理 → 投队列」，不 await 处理完：
  //   1) 同一 chat 的处理必须串行（上下文/回复顺序），不同 chat 可以并发——否则一个跑十分钟的
  //      turn 会把主循环堵死，主人发「停」和别的会话的消息全都收不到；
  //   2) 游标只能前移到「连续已完成」的最大 seq，队列里乱序完成的条目不能互相跳过。
  const chatQueues = new Map() // chat -> { jobs: Function[], draining: boolean }
  const inflightSeq = new Set() // 已投递、还没出结果
  const doneSeq = new Set() // 已处理完、但前面的 seq 还没完成
  const retrySeq = new Set() // 本轮失败、等下一轮重试（游标不许越过它）
  const queuedSeq = new Set() // 已经投进队列的 seq，防止每轮轮询重复投递
  const flushPending = new Set() // 某个 chat 的积压摘要已在队列里，别反复投

  // 积压摘要也走同一个 chat 队列：先入队的先执行，保证摘要排在后面的新消息前面
  function enqueueFlush(chat, reason) {
    if (flushPending.has(chat)) return
    flushPending.add(chat)
    enqueueChat(chat, async () => {
      try {
        await flushBacklog(chat, reason)
      } finally {
        flushPending.delete(chat)
      }
    })
  }

  function enqueueChat(chat, job, front) {
    const ch = chat || String()
    let q = chatQueues.get(ch)
    if (!q) {
      q = { jobs: [], draining: false }
      chatQueues.set(ch, q)
    }
    if (front) q.jobs.unshift(job)
    else q.jobs.push(job)
    if (!q.draining) drainChat(ch, q)
    return q
  }

  async function drainChat(ch, q) {
    q.draining = true
    try {
      while (q.jobs.length) {
        const job = q.jobs.shift()
        try {
          await job()
        } catch (e) {
          log('队列任务异常 chat=' + ch + ': ' + describeError(e))
        }
      }
    } finally {
      q.draining = false
      if (!q.jobs.length) chatQueues.delete(ch)
    }
  }

  function trackSeq(seq) {
    const n = Number(seq)
    if (Number.isFinite(n)) inflightSeq.add(n)
  }

  // 标记某条处理完并推进游标：只跨越「连续且已完成」的 seq
  async function commitCursor(seq) {
    const n = Number(seq)
    if (Number.isFinite(n)) {
      inflightSeq.delete(n)
      retrySeq.delete(n)
      queuedSeq.delete(n)
      doneSeq.add(n)
    }
    let next = Number(state.cursor) + 1
    while (!inflightSeq.has(next) && !retrySeq.has(next) && doneSeq.has(next)) {
      state.cursor = next
      doneSeq.delete(next)
      next += 1
    }
    if (!inflightSeq.size && !retrySeq.size && doneSeq.size) {
      // 出现空洞（历史 inbox 被清过 / seq 基线跳号）：跳到已完成的最大 seq，别让游标永久卡住
      const max = Math.max(...doneSeq)
      log('游标补洞：' + state.cursor + ' → ' + max + '（中间 seq 没有对应条目）')
      state.cursor = max
      doneSeq.clear()
    }
    await saveState()
  }

  // 失败：游标不许越过它，等下一轮重新投递
  function markRetry(seq) {
    const n = Number(seq)
    if (Number.isFinite(n)) {
      inflightSeq.delete(n)
      queuedSeq.delete(n)
      retrySeq.add(n)
    }
  }

  // 单条处理：失败不提交游标（下一轮重试），连续失败到上限才跳过，避免整条队列卡死
  async function handleEntryWithRetry(entry) {
    const seq = Number(entry.seq)
    try {
      await handleEntry(entry)
      if (Number.isFinite(seq)) entryAttempts.delete(seq)
      return true
    } catch (e) {
      state.lastError = describeError(e)
      const n = (entryAttempts.get(seq) || 0) + 1
      entryAttempts.set(seq, n)
      log('处理 seq=' + seq + ' 失败（第 ' + n + '/' + MAX_ENTRY_ATTEMPTS + ' 次）: ' + state.lastError)
      if (n >= MAX_ENTRY_ATTEMPTS) {
        log('seq=' + seq + ' 连续失败 ' + n + ' 次，跳过该条并前移游标（避免卡死整条队列）')
        entryAttempts.delete(seq)
        return true
      }
      return false
    }
  }

  async function flushBacklog(chat, reason) {
    const items = backlogByChat.get(chat) || []
    if (!items.length) return true
    const merged = makeBacklogEntry(items)
    log('积压摘要（' + reason + '）：' + chat + ' 共 ' + items.length + ' 条')
    const ok = await handleEntryWithRetry(merged)
    if (ok) {
      backlogByChat.delete(chat)
      backlogSync()
      await saveState()
    }
    return ok
  }

  async function pollOnce() {
    const out = await httpJson(base + '/inbox?since=' + state.cursor, { method: 'GET' }, 10000)
    const entries = (out && out.entries) || []
    if (!entries.length) return 0
    log('inbox 新增 ' + entries.length + ' 条（游标 ' + state.cursor + '）')
    state.lastStatus = { at: Date.now(), count: entries.length }
    const ageMin = Math.max(0, Number(cfg.backlogAgeMin) || 0)
    const mergeMin = Math.max(0, Number(cfg.backlogMergeMin) || 0)
    const maxHoldMin = Math.max(0, Number(cfg.backlogMaxHoldMin) || 180)
    for (const entry of entries) {
      const seq = Number(entry.seq)
      const chat = String(entry.chat || String())
      // 长任务跑着时游标不动，下一轮会把同样的条目再读一遍——已经投过队列的跳过
      if (Number.isFinite(seq) && queuedSeq.has(seq)) continue
      // 叫停 / 换会话这类指令本身很快，同步 await（插队执行），保证长任务跑着也能立刻停
      if (mustHandleNow(entry)) {
        trackSeq(seq)
        if (Number.isFinite(seq)) queuedSeq.add(seq)
        const ok = await handleEntryWithRetry(entry)
        if (ok) await commitCursor(seq)
        else markRetry(seq)
        continue
      }
      const age = entryAgeMin(entry)
      if (ageMin > 0 && mergeMin > 0 && age > ageMin) {
        if (hasResetPhrase(entry.content)) {
          const had = (backlogByChat.get(chat) || []).length
          if (had) log('积压作废：' + chat + ' 之前累计的 ' + had + ' 条旧消息被丢弃')
          backlogByChat.delete(chat)
          backlogSync()
        } else {
          backlogPush(chat, entry)
          log('积压入缓冲：' + chat + ' 现在 ' + (backlogByChat.get(chat) || []).length + ' 条（' + Math.round(age) + ' 分钟前）')
        }
        // 已写进 state.backlog 落盘，前移游标不会丢（走同一个连续性检查）
        trackSeq(seq)
        await commitCursor(seq)
        continue
      }
      if (backlogByChat.has(chat)) {
        // 先把积压摘要投进同一个 chat 队列，保证它排在这条新消息之前
        enqueueFlush(chat, '新消息前先消化积压')
      }
      trackSeq(seq)
      if (Number.isFinite(seq)) queuedSeq.add(seq)
      enqueueChat(chat, async () => {
        try {
          const ok = await handleEntryWithRetry(entry)
          if (ok) await commitCursor(seq)
          else markRetry(seq) // 游标不动，下一轮重新读出来再投一次
        } catch (e) {
          log('处理 seq=' + seq + ' 异常: ' + describeError(e))
          markRetry(seq)
        }
      })
    }
    // 跨轮累计：到条数阈值、或压得太久（默认 3 小时）就合并成一条摘要（投队列，不等）
    for (const chat of [...backlogByChat.keys()]) {
      const list = backlogByChat.get(chat) || []
      if (!list.length) continue
      const oldest = entryAgeMin(list[0])
      if ((mergeMin > 0 && list.length >= mergeMin) || (maxHoldMin > 0 && oldest > maxHoldMin)) {
        const reason = mergeMin > 0 && list.length >= mergeMin ? '累计 ' + list.length + ' 条' : '已积压 ' + Math.round(oldest) + ' 分钟'
        enqueueFlush(chat, reason)
      }
    }
    return entries.length
  }

  // ---- 派活回执（跨会话自动回流）----
  // 派给别的会话的活，跑完之后把最后一段回答搬回本会话。只搬最后一段、超长截断；
  // 两分钟没动静或三十分钟没产出就报一句，不让 lead 干等；不动目标会话的任何东西。
  const REFLOW_TIMEOUT_MS = Math.max(60, Number(cfg.reflowTimeoutMin) || 30) * 60 * 1000
  const REFLOW_SCAN_MS = Math.max(5, Number(cfg.reflowScanSec) || 20) * 1000
  const REFLOW_MAX_CHARS = Math.max(200, Number(cfg.reflowMaxChars) || 1200)
  let reflowLastScan = 0

  function reflowOwnerChat() {
    try {
      if (!state.sessions || !state.sessions.size) return String()
      return String([...state.sessions.keys()][0] || String())
    } catch {
      return String()
    }
  }
  function reflowLeadSession() {
    try {
      if (!state.sessions || !state.sessions.size) return ''
      return String([...state.sessions.values()][0] || '')
    } catch {
      return ''
    }
  }

  function trackReply(item) {
    if (!Array.isArray(state.pendingReplies)) state.pendingReplies = []
    const now = Date.now()
    const dup = state.pendingReplies.some((x) => x.targetSessionId === item.targetSessionId && now - Number(x.dispatchedAt || 0) < REFLOW_TIMEOUT_MS)
    if (dup) return false
    state.pendingReplies.push(item)
    return true
  }

  // 从事件里抠正文：assistant/message 的 data 结构有新老两版，逐层抓字符串取最长的那条
  // 注意：不能叫 textOfEvent，文件里已有一个同名函数（给 preview 用）
  function reflowTextOfEvent(ev) {
    // 2026-11-06 21:25：不猜结构，按多个已知位置依次取正文，一律跳过思考类 part。
    // 取不到时打一行结构日志，下次直接看日志定位，不用再摸黑。
    const d = (ev && ev.data) || {}
    const cands = []
    const push = (x) => {
      if (typeof x !== 'string') return
      const s = x.trim()
      if (s.length > 1) cands.push(s)
    }
    const isReasoning = (t) =>
      t === 'reasoning' || t === 'thinking' || t === 'reasoning-delta' || t === 'thinking-delta'
    const fromParts = (arr) => {
      if (!Array.isArray(arr)) return
      for (const x of arr) {
        if (!x) continue
        if (typeof x === 'string') { push(x); continue }
        if (isReasoning(String(x.type || ''))) continue
        push(x.text)
        push(x.content)
      }
    }
    fromParts(d.content)
    fromParts(d.parts)
    fromParts(d.message && d.message.content)
    push(d.text)
    push(d.message && d.message.text)
    if (cands.length > 0) {
      cands.sort((a, b) => b.length - a.length)
      return cands[0]
    }
    try {
      log('回执取不到正文：type=' + String((ev && ev.type) || '') + ' dataKeys=' + Object.keys(d).join(',') + ' content=' + JSON.stringify(d.content || d.parts || '').slice(0, 200))
    } catch (e) {}
    return ''
  }
  // 回执档位：raw = 原话直接转给主人；summary = 先注入本会话，由我读懂后汇总再发
  function reflowModeOf(item) {
    const short = String((item && item.targetShort) || "")
    const own = String((item && item.reflowMode) || "")
    if (own === "raw" || own === "summary") return own
    let m = ""
    try {
      const map = cfg.reflowModes
      if (map && typeof map === "object" && short) m = String(map[short] || "")
    } catch (e) {}
    if (m !== "raw" && m !== "summary") m = String(cfg.reflowMode || "summary")
    return m === "raw" ? "raw" : "summary"
  }

  async function pushReflow(leadId, item, note, body) {
    if (String(leadId) === String(item.targetSessionId)) {
      log('回执跳过：目标和本会话是同一个（' + String(item.targetShort || '') + '）')
      return
    }
    const title = item.targetTitle || item.targetShort || '目标会话'
    const head = '[回流] ' + title + '（' + String(item.targetShort || '') + '）' + (note ? '：' + note : ' 跑完了：')
    const body2 = String(body || '').trim()
    const text = body2
      ? head + String.fromCharCode(10) + (body2.length > REFLOW_MAX_CHARS ? body2.slice(0, REFLOW_MAX_CHARS) + '…（后面还有 ' + (body2.length - REFLOW_MAX_CHARS) + ' 字，要全文说一声）' : body2)
      : head + '（没抓到正文，原会话里应该有）'
    const ownerChat = reflowOwnerChat()
    if (!ownerChat) {
      log('回执跳过：找不到主人会话（' + title + '）')
      return
    }
    // 只注入、不抢答：promptAgent 会等「当前正在跑的那一轮」结束并把它的回答当自己的，
    // 20:10 与 21:12 两次错位就是这么来的（回执的肉落到上一轮回答上）。
    // 改成纯注入 + 尾巴明说「这轮答完用 wechat_secretary_send 发微信」。
    const mode = reflowModeOf(item)
    const tipRaw = '（回流提示：这一轮的回答请用 wechat_secretary_send 发到微信，别只在会话里说。）'
    const tipSum = '（回流提示：这是别的会话跑出来的结果，主人要的是你的总结、不是原话。请你读懂后用自己的话讲给主人——结论、关键数字、还差什么；用 wechat_secretary_send 发到微信。别原样转发。）'
    const ask = text + String.fromCharCode(10) + String.fromCharCode(10) + (mode === 'raw' ? tipRaw : tipSum)
    try {
      if (mode === 'raw') {
        const sent = await bridgeSend(ownerChat, text)
        log('回执已发微信（raw）→ ' + title + '（' + text.length + ' 字）' + JSON.stringify(sent || {}).slice(0, 120))
      } else {
        log('回执转 summary 档：不直接转发，交给本会话汇总 → ' + title + '（' + text.length + ' 字）')
      }
      const res = await dispatchToSession(leadId, ask, 'queue')
      log('回执已注入 → ' + title + '（' + ask.length + ' 字）' + JSON.stringify(res.sent || {}).slice(0, 120))

    } catch (e) {
      log('回执注入失败 ' + title + ': ' + describeError(e))
    }
  }

  async function maybeScanReplies() {
    if (!Array.isArray(state.pendingReplies) || state.pendingReplies.length === 0) return
    const now = Date.now()
    if (now - reflowLastScan < REFLOW_SCAN_MS) return
    reflowLastScan = now
    const leadId = reflowLeadSession()
    if (!leadId) return
    let list = []
    try {
      list = await listSessions(200)
    } catch (e) {
      log('回执扫描：列会话失败 ' + describeError(e))
      return
    }
    const keep = []
    for (const item of state.pendingReplies) {
      try {
        if (item.echo) {
          const es = list.find((x) => x.sessionId === item.targetSessionId)
          if (!es) { keep.push(item); continue }
          if (es.running) { item.sawRunning = true; keep.push(item); continue }
          if (!item.sawRunning) { keep.push(item); continue }
          const devs = await sessionRecentEvents(item.targetSessionId, es.asOfSeq, 40)
          const drs = (devs || []).filter((e) => /assistant\/message/.test(String((e && (e.type || e.kind)) || '')))
          if (!drs.length) { keep.push(item); continue }
          const dbody = reflowTextOfEvent(drs[drs.length - 1])
          if (dbody && item.ownerChat) {
            try {
              await bridgeSend(item.ownerChat, dbody)
              log('回执回显已发微信（' + dbody.length + ' 字）')
            } catch (de) {
              log('回执回显发送失败: ' + describeError(de))
            }
          }
          continue
        }
        const s = list.find((x) => x.sessionId === item.targetSessionId)
        const age = now - Number(item.dispatchedAt || 0)
        if (!s) {
          if (age > REFLOW_TIMEOUT_MS) {
            await pushReflow(leadId, item, '会话已经找不到了（可能被删或换工作区），这单没结果。', '')
            continue
          }
          keep.push(item)
          continue
        }
        if (s.running) {
          item.sawRunning = true
          if (age > REFLOW_TIMEOUT_MS) {
            await pushReflow(leadId, item, '跑了 ' + Math.round(age / 60000) + ' 分钟还在跑，先报一声，还在等。', '')
            continue
          }
          keep.push(item)
          continue
        }
        const updated = Date.parse(String(s.updatedAt || '')) || 0
        const moved = updated > Number(item.dispatchedAt || 0)
        if (!item.sawRunning && !moved) {
          if (age > 120000) {
            await pushReflow(leadId, item, '派过去两分钟了，对方会话没动（可能没跑起来，或卡在审批门）。', '')
            continue
          }
          keep.push(item)
          continue
        }
        const events = await sessionRecentEvents(item.targetSessionId, s.asOfSeq, 40)
        const replies = (events || []).filter((e) => /assistant\/message/.test(String((e && (e.type || e.kind)) || '')))
        if (!replies.length) {
          if (age > 120000) {
            await pushReflow(leadId, item, '会话动过了，但没抓到回答（可能被中断或只写了文件）。', '')
            continue
          }
          keep.push(item)
          continue
        }
        const modeHere = reflowModeOf(item)
        // summary 档多取几条：主人要看的是结论，单条容易只拿到一句「好的」
        const takeN = modeHere === 'raw' ? 1 : 3
        const picked = []
        for (const ev of replies.slice(-takeN)) {
          const t = reflowTextOfEvent(ev)
          if (t && picked.indexOf(t) < 0) picked.push(t)
        }
        const body = picked.join(String.fromCharCode(10) + String.fromCharCode(10))
        await pushReflow(leadId, item, '', body)
      } catch (e) {
        log('回执扫描 ' + String(item.targetShort || '') + ' 出错: ' + describeError(e))
        keep.push(item)
      }
    }
    state.pendingReplies = keep
    await saveState()
  }

  // ---- 启动自检 / 自动拉起 sidecar ----
  // DSH 每次重启后本地 bridge 不会自己起，通道就断。
  // 插件起来后探 GET sidecarHealthUrl：能连上就什么都不做；连不上就 detached spawn 一个，再探一次。
  // 只用健康检查判活，不扫进程、不杀进程、不碰系统设置；任何失败都只记日志。
  const sidecarState = {
    lastProbeAt: 0,
    lastProbeOk: null,
    lastStartAt: 0,
    startAttempts: 0,
    fails: 0,
    gaveUp: false,
  }

  async function probeSidecarHealth(timeoutMs = 2000) {
    try {
      const res = await fetch(cfg.sidecarHealthUrl, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch {
      return false
    }
  }

  function spawnSidecar() {
    const py = String(cfg.sidecarPythonPath || DEFAULTS.sidecarPythonPath)
    const script = String(cfg.sidecarScriptPath || DEFAULTS.sidecarScriptPath)
    const child = spawn(py, [script], {
      cwd: join(dirname(script), '..'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (e) => log('拉起 sidecar 进程异常: ' + describeError(e)))
    child.unref()
    return child
  }

  // 连不上时尝试拉起；60 秒最小间隔 + 连续失败上限，绝不每轮 spawn
  async function maybeStartSidecar(reason) {
    if (!cfg.autoStartSidecar || sidecarState.gaveUp) return false
    const now = Date.now()
    const gap = Math.max(5000, Number(cfg.sidecarStartMinGapMs) || 60000)
    if (now - sidecarState.lastStartAt < gap) return false
    sidecarState.lastStartAt = now
    sidecarState.startAttempts += 1
    try {
      spawnSidecar()
      log('sidecar 连不上，已尝试拉起（第 ' + sidecarState.startAttempts + ' 次，' + reason + '）')
    } catch (e) {
      sidecarState.fails += 1
      log('拉起 sidecar 失败: ' + describeError(e))
      return false
    }
    // 给解释器 3 秒起 HTTP，再探一次；这段在独立 tick 里跑，不阻塞轮询主循环
    await new Promise((r) => setTimeout(r, 3000))
    const ok = await probeSidecarHealth()
    sidecarState.lastProbeAt = Date.now()
    sidecarState.lastProbeOk = ok
    if (ok) {
      sidecarState.fails = 0
      sidecarState.gaveUp = false
      log('已自动拉起 sidecar（' + cfg.sidecarHealthUrl + ' 健康）')
      return true
    }
    sidecarState.fails += 1
    log('拉起 sidecar 后仍探不到（连续失败 ' + sidecarState.fails + ' 次）')
    if (sidecarState.fails >= Math.max(1, Number(cfg.sidecarStartMaxFails) || 5)) {
      sidecarState.gaveUp = true
      log('!!! sidecar 自动拉起已连续失败 ' + sidecarState.fails + ' 次，停手。' +
        '请检查 bridge 的 python 路径 / 脚本路径 / 端口占用，或手动启动 bridge；' +
        'sidecar 起来前微信收发不会恢复（本插件不会重启 DSH）。')
    }
    return false
  }

  // 一轮自检：先探活，活着什么都不做；死了才（受退避约束地）拉起
  async function sidecarSelfCheck(reason) {
    if (!cfg.autoStartSidecar || sidecarState.gaveUp) return false
    const ok = await probeSidecarHealth()
    sidecarState.lastProbeAt = Date.now()
    sidecarState.lastProbeOk = ok
    if (ok) {
      if (sidecarState.fails > 0) log('sidecar 健康检查恢复正常（此前连续失败 ' + sidecarState.fails + ' 次）')
      sidecarState.fails = 0
      sidecarState.gaveUp = false // 手动救活后，下一次掉线仍值得再试
      return true
    }
    return maybeStartSidecar(reason)
  }

  async function pollLoop() {
    if (!state.booted) {
      state.booted = true
      const restored = await loadState()
      backlogRestore()
      if (!restored) {
        // 首次启动：不重放历史，把游标推到当前最大 seq
        try {
          const out = await httpJson(base + '/inbox?since=0', { method: 'GET' }, 10000)
          const entries = (out && out.entries) || []
          for (const e of entries) {
            const s = Number(e.seq)
            if (Number.isFinite(s) && s > state.cursor) state.cursor = s
          }
          await saveState()
          log('首次启动，游标推到 ' + state.cursor)
        } catch (e) {
          log('初始化游标失败（bridge 没起来？）: ' + describeError(e))
        }
      }
    }
    try {
      await pollOnce()
      try {
        await maybeScanReplies()
      } catch (e) {
        log('回执扫描异常: ' + describeError(e))
      }
      state.lastError = null
      return true
    } catch (e) {
      state.lastError = describeError(e)
      return false
    }
  }

  // 后台轮询：随插件卸载自动清理
  ctx.effect(() => {
    if (!lock.ok) {
      log('单实例锁：另一实例持有 ' + lock.path + '，本实例只注册工具、不轮询')
      return () => {}
    }
    // 阶段④：记忆目录就绪（幂等；失败只记日志，不挡轮询）
    if (memory) {
      const r = memory.ensure()
      if (r && r.ok) log('记忆目录就绪 ' + r.dir)
      else log('记忆目录初始化失败: ' + (r && r.error))
    }
    let stopped = false
    let failStreak = 0
    let timer = null
    const baseDelay = Math.max(300, Number(cfg.pollMs) || 1000)
    const schedule = (ms) => {
      if (stopped) return
      timer = setTimeout(runOnce, ms)
    }
    const runOnce = () => {
      if (stopped) return
      enqueue(async () => {
        const ok = await pollLoop()
        if (stopped) return
        if (ok) {
          if (failStreak > 0) log('bridge 已恢复连接（此前连续失败 ' + failStreak + ' 次）')
          failStreak = 0
          schedule(baseDelay)
          return
        }
        failStreak += 1
        // 只在第 1、5 次和之后每 20 次记一行：sidecar 重启期间不要一秒一条刷屏
        if (failStreak === 1 || failStreak === 5 || failStreak % 20 === 0) {
          log('轮询失败（连续 ' + failStreak + ' 次，退避后重试）: ' + state.lastError)
        }
        const backoff = Math.min(baseDelay * Math.pow(2, Math.min(failStreak, 5)), 30000)
        schedule(backoff)
      }).catch(() => {})
    }
    runOnce()
    // 启动自检 + 自动拉起 sidecar：独立 tick，不 await、不阻塞轮询；失败只记日志。
    // 探活间隔 15 秒；真正 spawn 有 60 秒最小间隔和 5 次上限（见 sidecarSelfCheck）。
    let scTimer = null
    if (cfg.autoStartSidecar) {
      const scTick = () => {
        if (stopped) return
        sidecarSelfCheck('启动自检')
          .catch((e) => log('sidecar 自检异常: ' + describeError(e)))
          .finally(() => {
            if (!stopped) {
              scTimer = setTimeout(scTick, Math.max(5000, Number(cfg.sidecarProbeIntervalMs) || 15000))
            }
          })
      }
      scTimer = setTimeout(scTick, 300)
    }
    // 心跳：让锁文件的 mtime 保持新鲜，别的实例据此判断锁是不是僵尸锁
    const beat = setInterval(() => {
      if (stopped) return
      try {
        utimesSync(lock.path, new Date(), new Date())
      } catch {
        /* ignore */
      }
    }, 15000)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (scTimer) clearTimeout(scTimer)
      clearInterval(beat)
      try {
        unlinkSync(lock.path)
      } catch {
        /* ignore */
      }
    }
  })

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_status',
      description:
        '查看微信秘书插件的运行状态：是否连上本地 bridge、白名单会话、已处理消息数、当前会话游标、最近一次错误。排查用。',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        let health = null
        try {
          health = await httpJson(base + '/health', { method: 'GET' }, 5000)
        } catch (e) {
          health = { error: describeError(e) }
        }
        let deviceInfo = {
          enabled: !!deviceCfg.enabled,
          transport: deviceCfg.transport,
          baseUrl: deviceCfg.baseUrl,
          status: deviceCfg.enabled ? 'unknown' : 'disabled',
        }
        if (deviceCfg.enabled) {
          try {
            const h = await device.health(5000)
            deviceInfo = {
              ...deviceInfo,
              status: h && h.ok ? 'online' : 'offline',
              deviceId: h && h.deviceId,
              capabilities: (h && h.capabilities) || [],
              wechat: h && h.wechat,
              battery: h && h.battery,
              queue: h && h.queue,
            }
          } catch (e) {
            deviceInfo = { ...deviceInfo, status: 'offline', error: describeError(e) }
          }
        }
        const memoryInfo = memory
          ? (() => {
              try {
                const s = memory.stats()
                return {
                  enabled: true,
                  dir: s.dir,
                  facts: s.facts,
                  tasks: s.tasks,
                  daily: s.daily,
                  moods: s.moods,
                  profileChars: s.profileChars,
                }
              } catch (e) {
                return { enabled: true, error: describeError(e) }
              }
            })()
          : { enabled: false }
        const value = {
          ok: true,
          bridgeUrl: base,
          cwd: cfg.cwd,
          whitelist: Array.from(whitelist),
          cursor: state.cursor,
          handled: state.handled,
          blockedCount: state.blockedCount,
          lastBlockedAt: state.lastBlockedAt || null,
          sessions: Object.fromEntries(state.sessions),
          replyEnabled: cfg.replyEnabled,
          device: deviceInfo,
          memory: memoryInfo,
          // WorkItem 台账：现在在办什么 / 等谁 / 要不要人
          workitems: wiSnapshot(),
          booted: state.booted,
          uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
          bridge: health,
          lastError: state.lastError,
          message:
            '微信秘书：bridge=' + (health && health.ok ? '在线' : '离线') +
            '，白名单 ' + (whitelist.size || 0) + ' 个，游标 ' + state.cursor +
            '，已处理 ' + state.handled + ' 条' +
            '，blocked ' + state.blockedCount + ' 次' +
            '，在办 ' + wiSnapshot().counts.open + ' 单（需人 ' + wiSnapshot().counts.needsHuman + '）' +
            '，设备侧=' + (deviceInfo.enabled ? deviceInfo.status : '未启用') +
            '，记忆=' + (memoryInfo.enabled
              ? ((memoryInfo.facts && memoryInfo.facts.active) || 0) + ' 事实/' +
                ((memoryInfo.tasks && memoryInfo.tasks.open) || 0) + ' 未完成，' +
                ((memoryInfo.daily && memoryInfo.daily.days) || 0) + ' 天摘要，' +
                ((memoryInfo.moods && memoryInfo.moods.records) || 0) + ' 条情绪'
              : '关闭') +
            (state.lastError ? '，最近错误：' + state.lastError : ''),
        }
        return value
      },
    }),
  )

  // ---- 会话间派活 / 插话（2026-11-04 主人要求） ----------------------------------
  // DSH 的 Remote API 本来就有两条通道：session.prompt 的 mode='queue' 是"派活"（往另一个
  // 会话追加一条用户消息，忙就排队），mode='steer' 是"插话"（往正在跑的那一轮里插一句，
  // 到下一个步骤边界生效）。插件只负责把它们包成工具、加上白名单/开关，不做额外权限。
  async function rpcRaw(namespace, method, args, peer) {
    const gw = svc(ctx, 'typertGateway')
    if (!gw || typeof gw.invoke !== 'function') throw new Error('typertGateway 服务不可用')
    return gw.invoke({ namespace, method, args, peer, signal: peer && peer.signal })
  }

  async function listSessions(limit = 30) {
    const peer = peerScope()
    const res = await rpcRaw('session', 'list', { _request: { limit } }, peer)
    const items = (res && res.items) || []
    const cwd = String(cfg.cwd || '').toLowerCase()
    return items.map((item) => {
      const values = (item.projections && item.projections.values) || {}
      const itemCwd = String(item.cwd || '')
      return {
        sessionId: item.sessionId,
        short: String(item.sessionId).replace(/^session-/, '').slice(0, 8),
        title: values.title || null,
        cwd: item.cwd || null,
        sameWorkspace: !itemCwd || itemCwd.toLowerCase() === cwd,
        running: !!item.running,
        agentAvailable: item.agentAvailable !== false,
        blank: !!item.blank,
        updatedAt: item.updatedAt || null,
        asOfSeq: (item.projections && item.projections.asOfSeq) || 0,
      }
    })
  }

  async function dispatchToSession(sessionId, text, mode) {
    const peer = peerScope()
    const requestId = 'wd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const payload = {
      requestId,
      sessionId,
      mode: mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
    }
    let sent = null
    try {
      sent = await Promise.race([
        rpc('session', 'prompt', payload, peer),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20000)),
      ])
    } catch (e) {
      sent = { error: describeError(e) }
    }
    return { requestId, mode: payload.mode, sessionId, sent }
  }

  /**
   * 读一个会话最近的若干事件（只读，session.page）。
   * 用途：派活前判断目标会话是不是「中毒」状态——上一轮 blocked 且之后没有回答，
   * 这种会话再往里塞消息，DSH 会先 splice 插入、随即把消息移除并直接 turn/end blocked（2026-11-04 实测 25ms 内）。
   */
  async function sessionRecentEvents(sessionId, asOfSeq, maxMessages = 12) {
    const peer = peerScope()
    const throughSeq = Math.max(1, Number(asOfSeq) || 0)
    const msgs = Math.max(1, Math.min(Number(maxMessages) || 12, 500))
    const base = { address: { kind: 'session', sessionId }, throughSeq }
    const mapRecords = (res) =>
      ((res && res.records) || [])
        .map((r) => (r && r.type === 'event' && r.event) || (r && r.event) || r)
        .filter(Boolean)
    const tailLike = (arr) =>
      arr.length > 0 && /turn\/end|assistant\/message/.test(String((arr[arr.length - 1] || {}).type || ''))

    let res = await rpc('session', 'page', { ...base, maxMessages: msgs }, peer)
    let events = mapRecords(res)
    // session.page 默认给的是从会话开头起的窗口；我们要「尾部」。
    // 最后一条不是 turn/end / assistant/message 时，用 beforeSeq 从尾部往前再取一次。
    if (!tailLike(events)) {
      try {
        const res2 = await rpc('session', 'page', { ...base, beforeSeq: throughSeq + 1, maxMessages: msgs }, peer)
        const ev2 = mapRecords(res2)
        if (ev2.length) {
          events = ev2
          log('session.page 尾部取法生效 beforeSeq=' + (throughSeq + 1) + ' records=' + ev2.length +
            ' tail=' + String((ev2[ev2.length - 1] || {}).type || '?') + ' hasMore=' + String(!!(res2 && res2.hasMore)))
        }
      } catch (e) {
        log('session.page 尾部取法失败: ' + describeError(e))
      }
    }
    if (events.length === 0) {
      log('session.page 返回空：keys=' + (res ? Object.keys(res).join(',') : 'null') +
        ' head=' + JSON.stringify(res).slice(0, 300))
    }
    return events
  }

  /** 目标会话是否卡在「上一轮 blocked、之后没有产出」。返回 {stuck, reason, lastKind, since} */
  async function detectStuck(sessionId, asOfSeq) {
    let events = []
    try {
      events = await sessionRecentEvents(sessionId, asOfSeq, 200)
      log('卡死检测 ' + String(sessionId).slice(-12) + ' asOfSeq=' + asOfSeq + ' events=' + events.length +
        ' kinds=' + events.slice(-4).map((e) => String(e && (e.type || e.kind) || '?')).join(','))
    } catch (e) {
      // 读不到就当作不卡：宁可派进去，也别把正常会话误判成卡死
      log('卡死检测读取失败 ' + sessionId + ': ' + describeError(e))
      return { stuck: false, reason: 'page-failed: ' + describeError(e) }
    }
    // 从后往前找最后一条「产出」或「一轮结束」事件
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i] || {}
      const kind = String(ev.kind || ev.type || '')
      if (kind === 'assistant/message') return { stuck: false, lastKind: kind }
      if (/turn\/end/.test(kind)) {
        const reason = ev.data && ev.data.reason
        const rk = String((reason && reason.kind) || '')
        if (rk === 'blocked') {
          return { stuck: true, lastKind: kind, reason: 'blocked', since: ev.time || ev.at || null }
        }
        return { stuck: false, lastKind: kind, reason: rk || 'ok' }
      }
    }
    return { stuck: false, lastKind: events.length ? String(events[events.length - 1].kind || '') : 'empty' }
  }

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_sessions',
      description:
        '列出当前工作区的 DSH 会话（标题/短 id/是否在跑/最后更新时间），供"派活/插话"选目标。默认只列同工作区（当前工作区）的会话。',
      parameters: {
        limit: { type: 'number', description: '最多列多少条，默认 30' },
        only_running: { type: 'boolean', description: '只看正在跑的会话' },
        only_same_workspace: { type: 'boolean', description: '只看同工作区，默认 true' },
        query: { type: 'string', description: '按标题或短 id 过滤，例如 记忆 / 情绪' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100)
        const onlyRunning = !!args.only_running
        const sameOnly = args.only_same_workspace !== false
        const all = await listSessions(limit)
        let rows = all.filter((s) => (!onlyRunning || s.running) && (!sameOnly || s.sameWorkspace))
        const q = String(args.query || '').trim().toLowerCase()
        if (q) rows = rows.filter((s) => (String(s.title || '') + ' ' + String(s.short || '')).toLowerCase().indexOf(q) >= 0)
        const value = {
          ok: true,
          count: rows.length,
          running: rows.filter((s) => s.running).length,
          sessions: rows,
          message:
            '共 ' + rows.length + ' 个会话（在跑 ' + rows.filter((s) => s.running).length + ' 个）' +
            (rows.length
              ? '：' + rows.slice(0, 20).map((s) => (s.title || '未命名') + '(' + s.short + (s.running ? '·在跑' : '') + ')').join('、')
              : '') + (rows.length > 20 ? '，另有 ' + (rows.length - 20) + ' 条（用 query 按名字搜）' : ''),
        }
        return value
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_dispatch',
      description:
        '给另一个 DSH 会话派活（mode=queue，追加消息、忙则排队）或插话（mode=steer，插进正在跑的那一轮、到下一步生效）。只允许同一个工作区的会话；steer 默认关闭，需要配置 allowSteer=true 才放行。',
      parameters: {
        session_id: { type: 'string', description: '目标会话 id（从 wechat_secretary_sessions 拿）' },
        text: { type: 'string', description: '要派过去的话（按用户原话，别改成指令式）' },
        mode: { type: 'string', description: 'queue（默认，派活）| steer（插话）' },
        reflow: { type: 'string', description: '回执档位：summary（默认，我先读懂再汇总发你）| raw（原话直接转给你）' },
        reason: { type: 'string', description: '可选：为什么要派这一单，写进日志' },
        force: { type: 'boolean', description: '默认 false。目标会话卡在 blocked 时会拒派；确认仍要硬塞才传 true' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const sessionId = String(args.session_id || '').trim()
        const text = String(args.text || '').trim()
        const mode = String(args.mode || 'queue').toLowerCase() === 'steer' ? 'steer' : 'queue'
        if (!sessionId) throw new Error('session_id 必填（先用 wechat_secretary_sessions 找）')
        if (!text) throw new Error('text 必填')
        if (mode === 'steer' && !cfg.allowSteer) {
          return {
            ok: false,
            error: 'steer-disabled',
            message: '插话默认关闭（allowSteer=false）。要允许插话，把插件配置里 allowSteer 改成 true 再重载。',
          }
        }
        const known = await listSessions(100)
        const target = known.find((s) => s.sessionId === sessionId || s.short === sessionId.replace(/^session-/, '').slice(0, 8))
        if (!target) {
          return { ok: false, error: 'session-not-found', message: '没找到会话 ' + sessionId + '，先 wechat_secretary_sessions 看一眼。', sessions: known.slice(0, 10) }
        }
        if (!target.sameWorkspace && cfg.allowCrossWorkspace !== true) {
          return { ok: false, error: 'cross-workspace', message: '目标会话不在 ' + cfg.cwd + ' 工作区（cwd=' + target.cwd + '），DSH 会拒绝跨工作区派活。' }
        }
        // 卡死检测：目标会话若停在「上一轮 blocked 且没有回答」，插进去会被立刻 splice 掉并再次 blocked
        // （2026-11-04 19:45 在 e43f6685 上实测：25ms 内 spliced → turn/start → spliced(removed) → blocked）。
        if (!args.force) {
          const stuck = await detectStuck(target.sessionId, target.asOfSeq)
          if (stuck.stuck) {
            log('拒派：目标会话卡死 ' + target.short + '（' + stuck.lastKind + '）')
            return {
              ok: false,
              error: 'session-stuck',
              sessionId: target.sessionId,
              title: target.title,
              stuck,
              message:
                '目标会话「' + (target.title || target.short) + '」卡在上一轮的 blocked 状态（' +
                '消息刚插进去就会被移除并再次 blocked），派了也不会有人处理。' +
                '建议：换一个会话，或在那个会话里 /new 开新会话；确实要硬塞就传 force=true。',
            }
          }
        }
        // 目标会话若还挂着 ask 策略，一进场就被审批门挡成 blocked（19:45 实测过）。
        // 派活前先把它降到 never；不想动别的会话策略就把 dispatchRelaxApproval 设 false。
        let approvalNote = ''
        if (cfg.dispatchRelaxApproval !== false) {
          const relaxed = await relaxApproval(target.sessionId)
          if (relaxed && relaxed.ok) {
            approvalNote = relaxed.already ? '（目标会话本来就免审批）' : '（已把目标会话审批设为免审）'
          } else if (relaxed && relaxed.reason) {
            approvalNote = '（目标会话暂无活跃 agent，首轮可能仍被审批门挡住：' + relaxed.reason + '）'
          }
        }
        const res = await dispatchToSession(target.sessionId, text, mode)
        // 派出去的活登记一条回执：对方跑完自动把最后一段回答搬回本会话
        let reflowNote = ''
        if (mode === 'queue' && res.sent && !res.sent.error && text.indexOf('[回流]') !== 0) {
          const tracked = trackReply({
            targetSessionId: target.sessionId,
            targetShort: target.short,
            targetTitle: target.title || target.short,
            dispatchedAt: Date.now(),
            sawRunning: !!target.running,
            reason: String(args.reason || ''),
            reflowMode: String(args.reflow || ''),
          })
          if (tracked) {
            await saveState()
            reflowNote = '（跑完会自动把结果搬回来：' + (String(args.reflow || cfg.reflowMode || 'summary') === 'raw' ? '原话' : '我先读一遍再讲给你') + '）'
          }
        }
        log('派' + (mode === 'steer' ? '话' : '活') + ' → ' + target.short + '（' + (args.reason || '未写理由') + '）: ' + JSON.stringify(res.sent).slice(0, 200) + (approvalNote ? ' ' + approvalNote : ''))
        return {
          ok: !!(res.sent && !res.sent.error),
          mode: res.mode,
          sessionId: target.sessionId,
          title: target.title,
          requestId: res.requestId,
          result: res.sent,
          approvalNote,
          reflow: reflowNote || null,
          message:
            res.sent && res.sent.error
              ? '派活失败：' + JSON.stringify(res.sent.error)
              : (mode === 'steer' ? '插话已投递（到下一步生效）' : '已派活（会话忙则排队）') +
                '：' + (target.title || target.short) + approvalNote + reflowNote,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_sessionquery_probe',
      description:
        '排查用：直接摸 ctx.sessionQuery，列出它的方法、试读一个会话并返回完整错误链（本地部署里 session_search 报 "session history storage is unavailable" 时用它定位真因）。',
      parameters: {
        session_id: { type: 'string', description: '可选：要试读的会话 id，默认取 session.list 第一条' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const q = svc(ctx, 'sessionQuery')
        if (!q) {
          return { ok: false, error: 'no-service', message: 'ctx.sessionQuery 不存在——后端插件 dsh-session-query-sqlite 没有挂载。' }
        }
        let methods = []
        try {
          methods = Object.getOwnPropertyNames(Object.getPrototypeOf(q)).filter((n) => n !== 'constructor')
        } catch (e) {
          methods = ['<枚举失败: ' + describeError(e) + '>']
        }
        let targetId = String(args.session_id || '').trim()
        if (!targetId) {
          const rows = await listSessions(1)
          targetId = rows.length ? rows[0].sessionId : ''
        }
        const out = { ok: true, methods, targetId, message: '' }
        try {
          const observed = await q.observeSession(targetId)
          out.observe = { ok: true, keys: observed && Object.keys(observed || {}) }
          out.message = 'sessionQuery.observeSession 成功（方法 ' + methods.length + ' 个，目标 ' + targetId + '）'
        } catch (e) {
          const chain = []
          let cur = e
          for (let i = 0; i < 5 && cur; i += 1) {
            chain.push({
              name: cur.name,
              code: cur.code,
              message: cur.message,
              stack: String(cur.stack || '').split('\n').slice(0, 8).join('\n'),
            })
            cur = cur.cause
          }
          out.observe = { ok: false, chain }
          out.message = 'observeSession 失败：' + String((e && (e.code || e.message)) || e) +
            '（方法 ' + methods.length + ' 个）｜cause: ' + String((chain[1] && chain[1].message) || '无')
        }
        // 再试一次全文检索：本地报的 "session history storage is unavailable" 大概率出在这一步
        const searchName = (methods || []).find((m) => /search/i.test(m))
        out.searchMethod = searchName || null
        if (searchName && typeof q[searchName] === 'function') {
          try {
            const hit = await q[searchName]({ query: '打印机', limit: 5 })
            out.search = { ok: true, keys: hit && Object.keys(hit || {}) }
            out.message += '｜' + searchName + ' 成功'
          } catch (e) {
            const chain = []
            let cur = e
            for (let i = 0; i < 6 && cur; i += 1) {
              chain.push({ name: cur.name, code: cur.code, message: cur.message, stack: String(cur.stack || '').split('\n').slice(0, 10).join('\n') })
              cur = cur.cause
            }
            out.search = { ok: false, chain }
            out.message += '｜' + searchName + ' 失败：' + String((e && (e.code || e.message)) || e) +
              '｜cause: ' + String((chain[1] && chain[1].message) || '无').slice(0, 300)
            log('sessionQuery 检索失败: ' + JSON.stringify(chain).slice(0, 1500))
          }
        } else {
          out.message += '｜没有 search 方法：' + methods.join(',')
        }
        out.message += '｜方法：' + methods.join(',')
        return out
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_device',
      description:
        '设备侧（手机运行时）接口探针，按 README 的「设备侧接口」工作。action=status 看心跳/能力/微信登录；action=send 让设备发消息（调试用）；action=typing 发"正在输入"。设备侧默认未启用（device.enabled=false），本工具仍可用于与设备侧 mock 对接自检。',
      parameters: {
        action: { type: 'string', description: 'status（默认）| send | typing' },
        chat: { type: 'string', description: '目标会话 wxid，send/typing 时必填，默认白名单第一个' },
        text: { type: 'string', description: '要发送的正文，action=send 时必填' },
        file: { type: 'string', description: '可选：设备侧本地文件路径，action=send 时用' },
        baseUrl: { type: 'string', description: '可选：临时覆盖设备地址（如联调 mock 时传 http://127.0.0.1:8720）' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const action = String(args.action || 'status')
        const chat = args.chat || Array.from(whitelist)[0]
        const target = args.baseUrl
          ? makeDeviceTransport({ ...cfg, device: { ...deviceCfg, baseUrl: args.baseUrl } })
          : device
        const targetBase = args.baseUrl || deviceCfg.baseUrl
        if (action === 'status') {
          try {
            const h = await target.health(5000)
            return {
              ok: true,
              enabled: !!deviceCfg.enabled,
              baseUrl: targetBase,
              health: h,
              message: '设备侧在线：' + (h.deviceId || '?') + '，能力 ' +
                ((h.capabilities || []).join('/') || '无') + '，队列 ' + (h.queue || 0) +
                (deviceCfg.enabled ? '' : '（注意：device.enabled=false，未接入主流程）'),
            }
          } catch (e) {
            return {
              ok: false,
              enabled: !!deviceCfg.enabled,
              baseUrl: targetBase,
              error: describeError(e),
              message: '设备侧不可达（' + targetBase + '）：' + describeError(e),
            }
          }
        }
        if (action === 'send') {
          if (!chat) throw new Error('send 需要 chat')
          if (!args.text && !args.file) throw new Error('text 和 file 至少给一个')
          try {
            const r = await target.send(chat, args.text || '', args.file)
            return {
              ok: true,
              result: r,
              message: '已让设备侧发送，readback=' + (r && r.readback) + '，messageId=' + (r && r.messageId),
            }
          } catch (e) {
            return { ok: false, error: describeError(e), message: '设备侧发送失败：' + describeError(e) }
          }
        }
        if (action === 'typing') {
          if (!chat) throw new Error('typing 需要 chat')
          try {
            const r = await target.typing(chat, true)
            return { ok: true, result: r, message: '已请求设备侧显示"正在输入"' }
          } catch (e) {
            return { ok: false, error: describeError(e), message: '设备侧 typing 失败：' + describeError(e) }
          }
        }
        throw new Error('未知 action: ' + action)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_send',
      description:
        '用秘书（小号）给指定微信会话发文字和/或一个本地文件。不传 chat 时默认发给白名单里的主人。走的是本机微信 UI 自动化，会占用微信窗口几秒。',
      parameters: {
        text: { type: 'string', description: '要发送的正文（1500 字以内，只发文件时可省略）' },
        file: { type: 'string', description: '可选：要发送的本地文件绝对路径（最大 200MB）' },
        chat: { type: 'string', description: '目标会话 wxid，例如主人 wxid_master' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const chat = args.chat || Array.from(whitelist)[0]
        if (!chat) throw new Error('没有可用目标会话，请显式传 chat')
        if (!args.text && !args.file) throw new Error('text 和 file 至少给一个')
        const res = await bridgeSend(chat, args.text || '', args.file)
        return {
          ok: true, chat, result: res,
          message: '已请求发送，bridge 返回 readback=' + (res && res.readback) +
            (args.file ? '，file_readback=' + (res && res.file_readback) : ''),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_ask',
      description:
        '不经过微信、直接让微信秘书的 DSH 会话回答一句话（用于自检）。返回会话的最终回答文本。',
      parameters: {
        text: { type: 'string', required: true, description: '要问的话' },
        chat: { type: 'string', description: '会话键，默认使用白名单第一个' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const chat = args.chat || Array.from(whitelist)[0] || 'local-selfcheck'
        const result = await promptAgent(chat, args.text)
        return {
          ok: result.ok,
          sessionId: result.sessionId,
          answer: result.answer,
          seen: result.seen,
          message: result.ok
            ? result.answer
            : '（会话没有产出回答，session=' + result.sessionId + '；看到的事件：' +
              JSON.stringify(result.seen || []).slice(0, 1200) + '）',
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_probe',
      description: '排查用：对 session.page / session.list 试探参数形状，返回每个候选 payload 的成功/报错。',
      parameters: {
        sessionId: { type: 'string', description: '要试探的会话 id，可留空' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const peer = peerScope()
        const gw = svc(ctx, 'typertGateway')
        const rawRpc = (namespace, method, argsObj) =>
          gw.invoke({ namespace, method, args: argsObj, peer, signal: peer && peer.signal })
        let sid = String(args.sessionId || '').trim()
        if (!sid) {
          try {
            const created = await rawRpc('session', 'create', { request: { cwd: cfg.cwd } })
            sid = created && (created.sessionId || created.id)
          } catch (e) {
            sid = ''
          }
        }
        const candidates = []
        const push = (label, namespace, method, argsObj) => candidates.push({ label, namespace, method, args: argsObj })
        if (sid) {
          const addr = { kind: 'session', sessionId: sid }
          push('P1 request+address+max', 'session', 'page', { request: { address: addr, maxMessages: 20 } })
          push('P2 _request+address+max', 'session', 'page', { _request: { address: addr, maxMessages: 20 } })
          push('P3 request+address+throughSeq', 'session', 'page', { request: { address: addr, throughSeq: 1e9, maxMessages: 20 } })
          push('P4 request+address+beforeSeq', 'session', 'page', { request: { address: addr, beforeSeq: 1e9, maxMessages: 20 } })
          push('P5 request+sessionId only', 'session', 'page', { request: { sessionId: sid, maxMessages: 20 } })
          push('P6 request+address,no max', 'session', 'page', { request: { address: addr } })
        }
        push('L1 _request+limit', 'session', 'list', { _request: { limit: 5 } })
        push('L2 _request empty', 'session', 'list', { _request: {} })
        const results = []
        for (const c of candidates) {
          try {
            const out = await rawRpc(c.namespace, c.method, c.args)
            results.push({ label: c.label, ok: true, sample: JSON.stringify(out).slice(0, 600) })
          } catch (e) {
            results.push({ label: c.label, ok: false, error: describeError(e) })
          }
        }
        try {
          peer.dispose()
        } catch {
          /* ignore */
        }
        return {
          ok: true,
          sessionId: sid,
          results,
          message:
            'probe session=' + sid + '\n' +
            results.map((r) => r.label + ' => ' + (r.ok ? 'OK ' + r.sample : r.error)).join('\n'),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_policy',
      description:
        '排查/实验用：查看秘书会话的审批（approval）策略，并试探能否在插件里改。用于决定「手机上没法点审批」怎么处理（自动批准 vs 转微信审批）。',
      parameters: {
        sessionId: { type: 'string', description: '目标会话 id，默认用白名单会话当前的映射' },
        set: { type: 'string', description: '要试探设置的策略值（留空=只查看）' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const agents = svc(ctx, 'agents')
        const approval = svc(ctx, 'approval')
        let sid = String(args.sessionId || '').trim()
        if (!sid) {
          const chat = (cfg.whitelist || [])[0]
          sid = (chat && state.sessions.get(chat)) || ''
        }
        const lines = []
        lines.push('sessionId=' + (sid || '(none)'))
        if (!agents) lines.push('agents 服务不可用')
        if (!approval) lines.push('approval 服务不可用')
        let agent = null
        if (agents && sid) {
          try {
            agent = agents.get(sid)
            lines.push('agents.get → ' + (agent ? 'Agent id=' + agent.id : 'undefined（该会话不在本进程活跃列表里）'))
          } catch (e) {
            lines.push('agents.get 失败: ' + describeError(e))
          }
        }
        if (approval) {
          try {
            lines.push('approval 成员: ' + Object.keys(approval).join(','))
          } catch (e) {
            lines.push('列 approval 成员失败: ' + describeError(e))
          }
          try {
            const c = approval.config
            lines.push('approval.config: ' + JSON.stringify(c || null).slice(0, 400))
          } catch (e) {
            lines.push('读 approval.config 失败: ' + describeError(e))
          }
          try {
            lines.push('approval.overrideOf: ' + typeof approval.overrideOf)
            if (agent && typeof approval.overrideOf === 'function') {
              // overrideOf 要 Session，不是 Agent（Agent 上带 .session）
              const s = agent.session || agent
              lines.push('overrideOf(agent.session) → ' + JSON.stringify(approval.overrideOf(s)))
            }
          } catch (e) {
            lines.push('overrideOf 调用失败: ' + describeError(e) + '（它可能要 Session 而不是 Agent）')
          }
        }
        const set = String(args.set || '').trim()
        if (set && approval && agent) {
          const candidates = [set]
          if (/^(auto|automatic|never|allow|always|ask|deny|readonly)$/i.test(set)) {
            candidates.push({ mode: set })
            candidates.push({ kind: set })
          }
          for (const cand of candidates) {
            try {
              await approval.setPolicy(agent, cand)
              lines.push('setPolicy(' + JSON.stringify(cand) + ') → OK')
            } catch (e) {
              lines.push('setPolicy(' + JSON.stringify(cand) + ') → ' + describeError(e))
            }
          }
        } else if (set) {
          lines.push('缺少 agent 或 approval 服务，无法试探设置')
        }
        return { ok: true, message: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_approve',
      description:
        '高危操作前向主人请示：把问题发到微信，等主人回复后再继续（默认 5 分钟）。' +
        '返回 allow / deny / timeout。删文件、装或卸插件、改系统设置、往工作区外写、访问外网写操作之前必须调用。' +
        '插件有硬拦截：删/装/改系统类命令会被直接拒一次，主人隔着微信回「允许」后 10 分钟内可重试一次。',
      parameters: {
        question: { type: 'string', description: '要问主人的话（写清楚要做什么、影响什么）', required: true },
        options: { type: 'string', description: '可选项，逗号分隔，默认「允许,拒绝」' },
        timeoutSec: { type: 'number', description: '等待秒数，默认 300' },
        chat: { type: 'string', description: '发到哪个微信号，默认白名单第一个' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const chat = String(args.chat || (cfg.whitelist || [])[0] || '').trim()
        if (!chat) return { ok: false, message: '没有可用的 chat（白名单为空）' }
        const options = String(args.options || '允许,拒绝')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const question = String(args.question || '').trim()
        if (!question) return { ok: false, message: 'question 不能为空' }
        const timeoutMs = Math.max(30, Number(args.timeoutSec) || 300) * 1000
        const askText =
          '⚠️ 需要你确认：\n' + question + '\n' +
          options.map((opt, i) => i + 1 + '. ' + opt).join('\n') +
          '\n（回数字，或直接回「允许/拒绝」）'
        const sent = await bridgeSend(chat, askText, null)
        if (!sent || !sent.ok) return { ok: false, message: '请示消息没发出去：' + JSON.stringify(sent) }
        log('已发审批请示到 ' + chat + '（等待回复，超时 ' + Math.round(timeoutMs / 1000) + 's）')
        // 挂一个待批槽位：主人回复由 settleApproval() 消费并 resolve 这个 Promise
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (approvalWait && approvalWait.timer === timer) {
              approvalWait = null
              log('审批超时（' + Math.round(timeoutMs / 1000) + 's）')
              resolve({
                ok: true,
                decision: 'timeout',
                message: '等主人确认超时了（' + Math.round(timeoutMs / 1000) + 's），先别做这件事，把情况回给主人',
              })
            }
          }, timeoutMs)
          approvalWait = { chat, options, timer, resolve }
        })
        return result
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'wechat_secretary_memory',
      description:
        '查看/管理微信秘书的记忆（纯文件，路径见 stats）。action=list 列事实（默认只看 active）与未完成；add 手动记一条（仅在主人明确要求记住时用，不要凭上下文自行补记）；forget 按关键词忘掉；mood 看最近情绪（秘书自己的心情，只当口吻参考，不进事实库）；stats 看统计；preview 模拟“这条微信消息会注入什么”（查为什么记得/为什么没记住用这个）；prune 归档过期 inbox、失效事实与过期情绪（默认只预览）。',
      parameters: {
        action: { type: 'string', required: true, description: 'list | add | forget | mood | stats | preview | prune | reset' },
        text: { type: 'string', description: 'add 的正文；forget 的查询词' },
        category: {
          type: 'string',
          description: 'list 过滤 / add 指定：reference|preference|todo|workspace|profile|correction',
        },
        importance: { type: 'number', description: 'add 的重要度 1-5，默认 3' },
        status: { type: 'string', description: 'list 过滤：active（默认）| deleted | expired | all' },
        limit: { type: 'number', description: '条数上限，默认 10' },
        days: { type: 'number', description: 'mood 用：看近几天的情绪，默认 7' },
        message: { type: 'string', description: 'preview 要模拟的微信消息' },
        dryRun: { type: 'boolean', description: 'prune 是否只预览，默认 true' },
        inboxRetentionDays: { type: 'number', description: 'prune：inbox 保留天数，默认 30' },
        deletedRetentionDays: { type: 'number', description: 'prune：已删事实保留天数，默认 30' },
        chat: { type: 'string', description: 'reset 用：要清上下文的微信会话，默认白名单第一个' },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        if (!memory) return { ok: false, message: '记忆已关闭（config.memory.enabled=false）' }
        const action = String(args.action || 'stats')
        if (action === 'reset') {
          const chat = String(args.chat || Array.from(whitelist)[0] || '')
          if (!chat) return { ok: false, message: 'reset 需要 chat（白名单为空）' }
          const rotated = await rotateSession(chat, '手动清理上下文')
          return {
            ok: true,
            rotated,
            chat,
            message: rotated ? '已清掉 ' + chat + ' 的会话上下文，下一条消息会新建会话' : chat + ' 没有正在用的会话，下一条消息本来就是新会话',
          }
        }
        if (action === 'list') {
          const status = args.status ? String(args.status) : 'active'
          const facts = memory.list({
            status: status === 'all' ? null : status,
            category: args.category ? String(args.category) : null,
            limit: args.limit || 10,
          })
          const openTasks = memory.tasks({ status: 'open', limit: args.limit || 5 })
          return {
            ok: true,
            status,
            facts,
            tasks: openTasks,
            message:
              '记忆 ' + facts.length + ' 条（' + status + '）' +
              (facts.length
                ? '\n' + facts.map((f) => '- [' + f.category + '/' + f.status + '] ' + f.text + '（' + f.id + '）').join('\n')
                : '') +
              (openTasks.length
                ? '\n未完成 ' + openTasks.length + '：\n' + openTasks.map((t) => '- ' + t.intent + '（' + t.id + '）').join('\n')
                : ''),
          }
        }
        if (action === 'add') {
          const text = String(args.text || '').trim()
          if (!text) return { ok: false, message: 'add 需要 text' }
          const r = memory.addFact({
            text,
            category: args.category ? String(args.category) : undefined,
            importance: args.importance,
            confidence: 'explicit',
            source: { kind: 'manual', at: new Date().toISOString() },
          })
          return r.ok
            ? {
                ok: true,
                id: r.id,
                existed: !!r.existed,
                message: (r.existed ? '本来就有这条：' : '已记住：') + text + '（' + r.id + '）',
              }
            : { ok: false, error: r.error, message: '没记住：' + r.error }
        }
        if (action === 'forget') {
          const q = String(args.text || '').trim()
          if (!q) return { ok: false, message: 'forget 需要 text（要忘掉的关键词）' }
          const r = memory.forgetFacts(q)
          return { ok: r.ok, removed: r.removed, ids: r.ids, message: r.reply }
        }
        if (action === 'mood') {
          const s = memory.stats()
          const recent = memory.recentMoods({ days: args.days, max: args.limit || 10 })
          return {
            ok: true,
            recent,
            moods: s.moods,
            message:
              '最近情绪 ' + recent.length + ' 条（近 ' + ((s.config && s.config.moodRecentDays) || 7) + ' 天）' +
              (recent.length
                ? '\n' + recent
                    .map((m) => '- ' + m.label + (m.level === null || m.level === undefined ? '' : m.level) + (m.view ? '｜' + m.view : '') +
                      '（' + String(m.at || '').slice(5, 16).replace('T', ' ') + '）')
                    .join('\n')
                : '') +
              '\n台账里共 ' + s.moods.records + ' 条情绪记录；情绪只影响口吻，不进事实库。' +
              (s.moods && s.moods.deviation
                ? '\n自动校准：近 ' + s.moods.deviation.total + ' 条里偏低 ' + s.moods.deviation.low +
                  ' / 偏高 ' + s.moods.deviation.high + '（' +
                  (s.moods.deviation.bump > 0
                    ? '往高给 1 档'
                    : s.moods.deviation.bump < 0
                      ? '往低收 1 档'
                      : s.moods.deviation.total < 3
                        ? '样本不足 3 条，暂不校准'
                        : '暂不校准') +
                  '）'
                : ''),
          }
        }
        if (action === 'preview') {
          const msg = String(args.message || args.text || '').trim()
          const p = memory.preview(msg)
          return {
            ok: true,
            chars: p.chars,
            budget: p.budget,
            counts: p.counts,
            dropped: p.dropped,
            injection: p.text,
            message:
              '模拟消息：' + (msg || '（空）') + '\n注入 ' + p.chars + '/' + p.budget + ' 字' +
              '（未完成 ' + p.counts.pending + '，摘要 ' + p.counts.daily + '，事实 ' + p.counts.facts +
              '，情绪 ' + (p.counts.mood ? '有/' + p.moodChars + ' 字' : '无') +
              '，丢弃 ' + (p.dropped.join('/') || '无') + '）\n\n' + p.text,
          }
        }
        if (action === 'prune') {
          const report = memory.prune({
            dryRun: args.dryRun !== false,
            inboxRetentionDays: args.inboxRetentionDays,
            deletedRetentionDays: args.deletedRetentionDays,
          })
          return {
            ok: true,
            report,
            message:
              (report.dryRun ? '【预览，未动文件】' : '【已执行】') +
              '\ninbox 可归档 ' + report.inbox.length + ' 个' +
              (report.inbox.length ? '：' + report.inbox.map((x) => x.file).join('、') : '') +
              '\nfacts 可清理 ' + ((report.facts && report.facts.removed) || 0) + ' 行' +
              (report.facts ? '（' + report.facts.before + ' → ' + report.facts.after + '）' : '') +
              (report.moods ? '\n情绪可归档 ' + report.moods.removed + ' 条（保留 ' + report.moods.retentionDays + ' 天）' : '') +
              (report.facts && report.facts.backup ? '\n备份：' + report.facts.backup : ''),
          }
        }
        if (action === 'stats') {
          const s = memory.stats()
          return {
            ok: true,
            ...s,
            message:
              '记忆目录：' + s.dir + '\n' +
              '事实：active ' + s.facts.active + ' / 已删 ' + s.facts.deleted + ' / 已作废 ' + s.facts.expired +
              ' / 共 ' + s.facts.total + '\n' +
              '台账：未完成 ' + s.tasks.open + ' / 完成 ' + s.tasks.done + ' / 共 ' + s.tasks.total + '\n' +
              '摘要：' + s.daily.days + ' 天' + (s.daily.last ? '（最后 ' + s.daily.last.date + '）' : '') + '\n' +
              '情绪：台账 ' + (s.moods ? s.moods.records : 0) + ' 条 / 近 ' + ((s.config && s.config.moodRecentDays) || 7) +
              ' 天 ' + (s.moods ? s.moods.recent : 0) + ' 条（只当口吻，不进事实库）' +
              (s.moods && s.moods.deviation
                ? '；偏差 偏低 ' + s.moods.deviation.low + ' / 偏高 ' + s.moods.deviation.high +
                  '（' + (s.moods.deviation.bump ? '校准' + (s.moods.deviation.bump > 0 ? '+1' : '-1') + ' 档' : '暂不校准') + '）'
                : '') + '\n' +
              '画像：' + s.profileChars + ' 字；facts ' + s.sizes.factsBytes + ' B，tasks ' + s.sizes.tasksBytes + ' B\n' +
              '注入预算：' + s.config.injectBudgetChars + ' 字（画像前 ' + s.config.profileBudgetChars + ' 字）',
          }
        }
        return { ok: false, message: '未知 action：' + action + '（list|add|forget|mood|stats|preview|prune|reset）' }
      },
    }),
  )

  // ---- 只读「需要人」面板的数据源 ----
  // 界面半边（client.js）每 5 秒拉一次；这里只读台账，不提供任何写操作。
  ctx.inject(['webServer'], (httpCtx) => {
    try {
      const server = httpCtx.webServer
      if (!server || typeof server.register !== 'function') {
        log('没有 webServer，面板数据接口跳过（工具与微信通道不受影响）')
        return
      }
      httpCtx.effect(
        () =>
          server.register({
            kind: 'exact',
            path: '/wechat-secretary/workitems',
            handler: (req, res) => {
              try {
                if (String(req.method || 'GET').toUpperCase() !== 'GET') {
                  res.statusCode = 405
                  res.end()
                  return
                }
                let clientHalf = null
                try {
                  const cm = svc(ctx, 'clientModules')
                  if (cm && typeof cm.graph === 'function') {
                    const g = cm.graph()
                    const ids = Array.isArray(g && g.entries) ? g.entries.map((e) => e.id) : []
                    clientHalf = {
                      count: ids.length,
                      found: ids.includes('dsh-wechat-secretary'),
                      watch: ids.filter((x) => /wechat|lock|market|skill|im/i.test(String(x))).slice(0, 20),
                      tail: ids.slice(-10),
                      rev: g && g.rev,
                    }
                  }
                } catch (e) {
                  clientHalf = { error: describeError(e) }
                }
                const body = JSON.stringify({
                  ok: true,
                  cursor: state.cursor,
                  bridgeUrl: base,
                  handled: state.handled,
                  blockedCount: state.blockedCount,
                  lastBlockedAt: state.lastBlockedAt,
                  sessions: sessionSnapshot(),
                  resumed: resumedHandles.size,
                  clientHalf,
                  ...wiSnapshot(15),
                })
                res.statusCode = 200
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.setHeader('Cache-Control', 'no-store')
                res.end(body)
              } catch (e) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json; charset=utf-8')
                res.end(JSON.stringify({ ok: false, error: describeError(e) }))
              }
            },
          }),
        'wechat-secretary: workitems 面板数据接口',
      )
      log('面板数据接口已挂：/wechat-secretary/workitems')
    } catch (e) {
      log('面板数据接口注册失败: ' + describeError(e))
    }
  })

  log('已加载：bridge=' + base + ' cwd=' + cfg.cwd + ' whitelist=' + Array.from(whitelist).join(','))
}
