// vision-bridge.mjs — host-level plugin: give text-only DSH agents vision.
//
// Supports multiple vision backends:
//   1. API backend (OpenAI-compatible Vision API: OpenAI, Groq, Together, etc.)
//   2. CDP backend (desktop app CDP bridge: Doubao, etc.)
//
// Loaded from $DSH_HOME/cordis.patch.yml (user patch layer, all profiles).
// Toggle via `disabled: true` on the plugin row; the change is hot.
//
// Based on doubao-vision-dsh by hawkongz, rewritten with:
//   - Dynamic path resolution (no hardcoded user paths)
//   - Cross-platform support (Windows / macOS / Linux)
//   - Multiple vision backends (API + CDP)
//   - Persistent cache (content-hash keyed, configurable)
//   - Configurable via cordis.patch.yml `config` block
//   - Structured error messages (no swallowed exceptions)

import { writeFileSync, appendFileSync, statSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir, platform } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const PLATFORM = platform()
const IS_WIN = PLATFORM === 'win32'
const IS_MAC = PLATFORM === 'darwin'

// ── Defaults ───────────────────────────────────────────────────────────────

const DSH_HOME = String(process.env.DSH_HOME || join(homedir(), '.dsh'))
const LOG_FILE = join(DSH_HOME, 'plugins', 'vision-bridge.log')
const CACHE_DIR = join(DSH_HOME, 'cache', 'vision-bridge')
const COLLECT_DIR = join(DSH_HOME, 'attachments', 'collected')

const DEFAULT_QUESTION = '请详细描述这张图片的内容，包括图中的文字信息'
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CDP_PORT = 9225

// Doubao desktop app paths per platform
const DOUBAO_EXE_PATHS = {
  win32: join(homedir(), 'AppData', 'Local', 'Doubao', 'Application', 'app', 'Doubao.exe'),
  darwin: '/Applications/Doubao.app/Contents/MacOS/Doubao',
  linux: null, // Linux path varies; user must configure
}

const PATCHED = Symbol.for('vision-bridge.patched')

let patchRefs = 0
let globalLlm = null
let globalOffUpdated = null
let globalConfig = null

// ── Logging ────────────────────────────────────────────────────────────────

function logLine(msg) {
  try {
    const line = new Date().toISOString() + ' ' + msg + '\n'
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 200_000) {
        writeFileSync(LOG_FILE, '')
      }
    } catch { /* file may not exist yet */ }
    appendFileSync(LOG_FILE, line)
  } catch { /* logging is best-effort */ }
}

function logError(msg, err) {
  const detail = err instanceof Error ? err.message : String(err)
  logLine('ERROR: ' + msg + ' — ' + detail)
}

// ── Utils ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('识别等待超时（' + Math.round(ms / 1000) + '秒），已放弃')),
      ms,
    )
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (v) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function fileHash(filePath) {
  const buf = readFileSync(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

function shortHash(hex) {
  return hex.slice(0, 8)
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

// ── Cache ───────────────────────────────────────────────────────────────────

class VisionCache {
  constructor(dir, maxEntries = 200) {
    this.dir = dir
    this.maxEntries = maxEntries
    this.memory = new Map()
    try {
      mkdirSync(dir, { recursive: true })
    } catch { /* dir may already exist */ }
  }

  key(filePath, question) {
    try {
      const hash = fileHash(filePath)
      const qHash = createHash('md5').update(question).digest('hex').slice(0, 8)
      return hash + '_' + qHash
    } catch {
      return null
    }
  }

  get(filePath, question) {
    const key = this.key(filePath, question)
    if (!key) return null

    if (this.memory.has(key)) return this.memory.get(key)

    const cacheFile = join(this.dir, key + '.txt')
    try {
      const text = readFileSync(cacheFile, 'utf-8')
      this.memory.set(key, text)
      return text
    } catch {
      return null
    }
  }

  set(filePath, question, text) {
    const key = this.key(filePath, question)
    if (!key) return

    this.memory.set(key, text)
    const cacheFile = join(this.dir, key + '.txt')
    try {
      writeFileSync(cacheFile, text, 'utf-8')
      this.evict()
    } catch { /* cache write is best-effort */ }
  }

  evict() {
    try {
      const files = []
      for (const name of readdirSyncSafe(this.dir)) {
        if (!name.endsWith('.txt')) continue
        const full = join(this.dir, name)
        const stat = statSync(full)
        files.push({ name: full, mtime: stat.mtimeMs })
      }
      if (files.length <= this.maxEntries) return
      files.sort((a, b) => a.mtime - b.mtime)
      for (let i = 0; i < files.length - this.maxEntries; i++) {
        try { unlinkSyncSafe(files[i].name) } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function unlinkSyncSafe(file) {
  try {
    unlinkSync(file)
  } catch { /* best-effort */ }
}

let cacheInstance = null

function getCache() {
  if (!cacheInstance) {
    cacheInstance = new VisionCache(
      globalConfig?.cacheDir || CACHE_DIR,
      globalConfig?.cacheMaxEntries || 200,
    )
  }
  return cacheInstance
}

// ── API Backend (OpenAI-compatible Vision) ─────────────────────────────────

async function recognizeViaApi(filePath, question, cfg, signal) {
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('API 后端需要 API key，请在配置中设置 apiKey 或设置 OPENAI_API_KEY 环境变量')
  }

  const baseURL = cfg.apiBase || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const model = cfg.apiModel || 'gpt-4o'

  logLine('api: reading image ' + filePath)
  const imageBuffer = readFileSync(filePath)
  const base64 = imageBuffer.toString('base64')
  const ext = basename(filePath).split('.').pop()?.toLowerCase() || 'png'
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/png'

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: 'data:' + mimeType + ';base64,' + base64 } },
        ],
      },
    ],
    max_tokens: 1024,
  }

  const url = baseURL.replace(/\/$/, '') + '/chat/completions'
  logLine('api: POST ' + url + ' model=' + model + ' size=' + imageBuffer.length + ' bytes')

  const controller = new AbortController()
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS
  const timeout = setTimeout(() => {
    logLine('api: request timed out after ' + timeoutMs + 'ms')
    controller.abort()
  }, timeoutMs)
  if (signal) {
    signal.addEventListener('abort', () => {
      logLine('api: external abort signal received')
      controller.abort()
    }, { once: true })
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    logLine('api: response status=' + resp.status)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      logError('api: error response body', errText.slice(0, 500))
      throw new Error('Vision API 返回 ' + resp.status + ': ' + errText.slice(0, 200))
    }

    const data = await resp.json()
    const text = data?.choices?.[0]?.message?.content
    if (!text) {
      logError('api: empty content in response', JSON.stringify(data).slice(0, 300))
      throw new Error('Vision API 返回空内容')
    }
    return text
  } finally {
    clearTimeout(timeout)
  }
}

// ── CDP Backend (desktop app bridge: Doubao, etc.) ──────────────────────────

function findChatTarget(targets, appUrlPrefix) {
  const pages = (targets || []).filter((t) => t.type === 'page')
  const chat = pages.find((t) => t.url.indexOf(appUrlPrefix) === 0)
  if (chat) return chat
  const anyChat = pages.find((t) => t.url.indexOf(appUrlPrefix.replace('/chat', '')) === 0)
  if (anyChat) return anyChat
  return pages[0]
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
  }

  connect(timeoutMs) {
    const self = this
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(self.wsUrl)
      self.ws = ws

      const to = setTimeout(() => {
        try { ws.close() } catch { /* */ }
        reject(new Error('CDP 连接超时'))
      }, timeoutMs || 10_000)

      ws.onopen = () => { clearTimeout(to); resolve() }
      ws.onerror = () => { clearTimeout(to); reject(new Error('CDP websocket 错误')) }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && self.pending.has(msg.id)) {
          const entry = self.pending.get(msg.id)
          self.pending.delete(msg.id)
          if (msg.error) {
            entry.reject(new Error('CDP ' + (msg.error.message || JSON.stringify(msg.error))))
          } else {
            entry.resolve(msg.result)
          }
        }
      }
    })
  }

  send(method, params, timeoutMs) {
    const self = this
    return new Promise((resolve, reject) => {
      const msgId = ++self.id
      self.pending.set(msgId, { resolve, reject })
      try {
        self.ws.send(JSON.stringify({ id: msgId, method, params: params || {} }))
      } catch (e) {
        self.pending.delete(msgId)
        reject(e)
        return
      }
      setTimeout(() => {
        if (self.pending.has(msgId)) {
          self.pending.delete(msgId)
          reject(new Error('CDP 超时: ' + method))
        }
      }, timeoutMs || 8000)
    })
  }

  close() {
    try { this.ws.close() } catch { /* */ }
  }
}

async function evaluate(cdp, expression, timeoutMs) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs || 8000,
  )
  if (r.exceptionDetails) {
    const desc = r.exceptionDetails.exception?.description || r.exceptionDetails.text
    throw new Error('页面异常: ' + JSON.stringify(desc))
  }
  return r.result.value
}

async function setFileInput(cdp, filePath, uploadSelector) {
  const doc = await cdp.send('DOM.getDocument', { depth: 1 })
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: uploadSelector || '[data-testid="upload-file-input"]' })
  if (!q.nodeId) throw new Error('未找到上传文件输入框（selector: ' + (uploadSelector || '[data-testid="upload-file-input"]') + '）')
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [filePath] })
}

function injectTextScript(text, textareaSelector) {
  const sel = textareaSelector || '[data-testid="chat_input_input"]'
  return '(function(t){var ta=document.querySelector(\'' + sel + '\');'
    + 'if(!ta)return {ok:false,error:"No textarea found"};ta.focus();'
    + 'var d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value");'
    + 'var s=d&&d.set;if(s)s.call(ta,t);else ta.value=t;'
    + 'ta.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'ta.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'return {ok:true};})(' + JSON.stringify(text) + ')'
}

const CLICK_SEND_DEFAULT = '(function(){'
  + 'var b=document.querySelector(\'[data-testid="chat_input_send_button"]\');'
  + 'if(b){b.click();return "clicked";}'
  + 'var ta=document.querySelector(\'[data-testid="chat_input_input"]\');'
  + 'if(!ta)return "none";'
  + 'var k=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true});'
  + 'ta.dispatchEvent(k);'
  + 'var u=new KeyboardEvent("keyup",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true});'
  + 'ta.dispatchEvent(u);return "enter-key";})()'

function lastMessageScript(baselineId, msgSelector) {
  const sel = msgSelector || '[data-testid="message_content"]'
  return '(function(baseline){'
    + 'var ms=document.querySelectorAll(\'' + sel + '\');'
    + 'if(ms.length===0)return {phase:"waiting",text:null};'
    + 'var last=ms[ms.length-1];'
    + 'var isUser=!!(last.classList&&last.classList.contains("justify-end"));'
    + 'if(isUser)return {phase:"waiting",text:null};'
    + 'var id=last.getAttribute("data-message-id")||"";'
    + 'var col=null;'
    + 'var divs=last.querySelectorAll("div");'
    + 'for(var i=0;i<divs.length;i++){'
    + 'var el=divs[i];'
    + 'if(el.children.length>=2){'
    + 'var t=(el.children[0].textContent||"").trim();'
    + 'if(t.indexOf("正在")===0||t.indexOf("思考中")>=0||t.indexOf("深度思考")===0||t.indexOf("已完成思考")===0||t.indexOf("已深度思考")===0){col=el;break;}'
    + '}'
    + '}'
    + 'var answerEl=null;'
    + 'if(col){'
    + 'var t0=(col.children[0].textContent||"").trim();'
    + 'if(t0.indexOf("正在")===0||t0.indexOf("思考中")>=0||t0.indexOf("深度思考")===0)return {phase:"waiting",text:null};'
    + 'var best=null,bestLen=-1;'
    + 'for(var k=1;k<col.children.length;k++){var cl=col.children[k];var l=(cl.textContent||"").length;if(l>bestLen){bestLen=l;best=cl;}}'
    + 'answerEl=best||col.children[col.children.length-1];'
    + '}else{'
    + 'var tl=(last.textContent||"").trim();'
    + 'if(tl.indexOf("正在")===0||tl.indexOf("思考中")>=0||tl.indexOf("深度思考")===0)return {phase:"waiting",text:null};'
    + 'answerEl=last;'
    + '}'
    + 'var text="";'
    + 'var kids=answerEl.querySelectorAll("div[dir]");'
    + 'if(kids.length>0){var parts=[];for(var j=0;j<kids.length;j++){parts.push(kids[j].innerText||kids[j].textContent||"");}text=parts.join("");}'
    + 'else{text=(answerEl.innerText||answerEl.textContent||"").trim();}'
    + 'var fresh=text&&(id!==baseline);'
    + 'return {phase:fresh?"done":"waiting",text:text,id:id};'
    + '})(' + JSON.stringify(baselineId) + ')'
}

const CLICK_NEW_CHAT_DEFAULT = '(function(){'
  + 'var b=document.querySelector(\'[data-testid="new_chat_button"]\');'
  + 'if(b){b.click();return true;}'
  + 'var s=document.querySelector(\'[data-testid="app-open-newChat"]\');'
  + 'if(s){s.click();return true;}'
  + 'return false;})()'

function inputReadyScript(textareaSelector, uploadSelector) {
  const ts = textareaSelector || '[data-testid="chat_input_input"]'
  const us = uploadSelector || '[data-testid="upload-file-input"]'
  return '(function(){'
    + 'var ta=document.querySelector(\'' + ts + '\');'
    + 'var up=document.querySelector(\'' + us + '\');'
    + 'return {textarea:!!ta, upload:!!up};'
    + '})()'
}

function sentCheckScript(baselineId, msgSelector) {
  const sel = msgSelector || '[data-testid="message_content"]'
  return '(function(baseline){'
    + 'var ms=document.querySelectorAll(\'' + sel + '\');'
    + 'for(var i=0;i<ms.length;i++){'
    + 'var id=(ms[i].getAttribute("data-message-id"))||"";'
    + 'var isUser=!!(ms[i].classList&&ms[i].classList.contains("justify-end"));'
    + 'if(id&&id!==baseline&&isUser)return {sent:true};'
    + '}'
    + 'return {sent:false};'
    + '})(' + JSON.stringify(baselineId) + ')'
}

function prevTurnScript(msgSelector) {
  const sel = msgSelector || '[data-testid="message_content"]'
  return '(function(){'
    + 'var ms=document.querySelectorAll(\'' + sel + '\');'
    + 'if(ms.length===0)return "ready";'
    + 'var last=ms[ms.length-1];'
    + 'var isUser=!!(last.classList&&last.classList.contains("justify-end"));'
    + 'if(isUser)return "ready";'
    + 'var t=(last.textContent||"").trim();'
    + 'if(t.indexOf("正在")===0||t.indexOf("思考中")>=0||t.indexOf("深度思考")===0)return "busy";'
    + 'return "ready";'
    + '})()'
}

function prevTurnTextScript(msgSelector) {
  const sel = msgSelector || '[data-testid="message_content"]'
  return '(function(){'
    + 'var ms=document.querySelectorAll(\'' + sel + '\');'
    + 'if(!ms.length)return "";'
    + 'var last=ms[ms.length-1];'
    + 'var t=(last.textContent||"").trim();'
    + 'return t.slice(-2000);'
    + '})()'
}

async function awaitPreviousTurn(cdp, cfg, timeoutMs, signal) {
  const deadline = Date.now() + (timeoutMs || 30_000)
  let prevText = null

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('已取消')

    let state = null
    let text = null
    try {
      state = await evaluate(cdp, prevTurnScript(cfg.cdpMsgSelector), 4000)
    } catch (e) { logError('awaitPreviousTurn state check', e) }
    try {
      text = await evaluate(cdp, prevTurnTextScript(cfg.cdpMsgSelector), 4000)
    } catch (e) { logError('awaitPreviousTurn text check', e) }

    if (state === 'ready') {
      if (prevText === null || text === prevText) return
      prevText = text
    }
    await sleep(500)
  }
  logLine('awaitPreviousTurn: timed out, proceeding anyway')
}

async function ensureCdpApp(cfg) {
  const port = cfg.cdpPort || DEFAULT_CDP_PORT
  const exePath = cfg.cdpExePath || DOUBAO_EXE_PATHS[PLATFORM]

  if (!exePath && PLATFORM === 'linux') {
    throw new Error('Linux 上使用 CDP 后端需要配置 cdpExePath（桌面应用路径）')
  }

  // Check if app is already running with debug port
  try {
    const resp = await fetch('http://127.0.0.1:' + port + '/json/version', {
      signal: AbortSignal.timeout(2000),
    })
    if (resp.ok) return port
  } catch { /* app not running or not ready */ }

  // Kill existing process (cross-platform)
  if (IS_WIN) {
    try {
      await execFileP('taskkill', ['/IM', basename(exePath || 'Doubao.exe'), '/F'], { timeout: 5000 })
    } catch { /* process may not exist */ }
  } else {
    try {
      const pids = await execFileP('pgrep', ['-f', basename(exePath || 'Doubao')], { timeout: 5000 })
      const pidList = pids.trim().split('\n').filter(Boolean)
      for (const pid of pidList) {
        try { process.kill(parseInt(pid, 10), 'SIGTERM') } catch { /* */ }
      }
    } catch { /* pgrep found nothing or not available */ }
  }

  await sleep(500)

  // Start app with debug port
  const args = ['--remote-debugging-port=' + port]
  try {
    await execFileP(exePath, args, { detached: true, stdio: 'ignore' })
  } catch (e) {
    throw new Error('无法启动桌面应用（' + exePath + '）: ' + e.message)
  }

  // Wait for CDP endpoint
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(1000)
    try {
      const resp = await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(2000),
      })
      if (resp.ok) {
        logLine('CDP app ready on port ' + port)
        return port
      }
    } catch { /* still starting */ }
  }
  throw new Error('桌面应用启动超时（30秒内未就绪）')
}

async function recognizeViaCdp(filePath, question, cfg, signal) {
  const port = await ensureCdpApp(cfg)

  // Discover CDP targets
  let targets
  try {
    const resp = await fetch('http://127.0.0.1:' + port + '/json', {
      signal: AbortSignal.timeout(5000),
    })
    targets = await resp.json()
  } catch (e) {
    throw new Error('无法获取 CDP 目标列表: ' + e.message)
  }

  const appUrlPrefix = cfg.cdpAppUrlPrefix || 'doubao://doubao-chat/chat'
  const target = findChatTarget(targets, appUrlPrefix)
  if (!target) throw new Error('未找到聊天页面目标')

  const wsUrl = target.webSocketDebuggerUrl
  if (!wsUrl) throw new Error('目标缺少 webSocketDebuggerUrl')

  const cdp = new CdpClient(wsUrl)
  try {
    await cdp.connect(10_000)

    // Wait for input readiness
    const inputSel = cfg.cdpTextareaSelector
    const uploadSel = cfg.cdpUploadSelector
    const readyDeadline = Date.now() + 15_000
    while (Date.now() < readyDeadline) {
      if (signal?.aborted) throw new Error('已取消')
      try {
        const ready = await evaluate(cdp, inputReadyScript(inputSel, uploadSel), 4000)
        if (ready?.textarea && ready?.upload) break
      } catch { /* */ }
      await sleep(1000)
    }

    // Wait for previous turn to finish
    await withTimeout(
      awaitPreviousTurn(cdp, cfg, 30_000, signal),
      35_000,
      signal,
    )

    // Get baseline message id
    let baselineId = ''
    try {
      const ms = await evaluate(cdp, '(function(){var m=document.querySelectorAll(\'[data-testid="message_content"]\');if(!m.length)return "";var l=m[m.length-1];return l.getAttribute("data-message-id")||"";})()', 4000)
      baselineId = ms || ''
    } catch { /* */ }

    // Upload file
    await setFileInput(cdp, filePath, uploadSel)

    // Wait for upload to settle
    await sleep(1000)

    // Inject question text
    const textResult = await evaluate(cdp, injectTextScript(question, inputSel), 4000)
    if (textResult && !textResult.ok) {
      logLine('injectText: ' + (textResult.error || 'unknown'))
    }

    // Click send
    const clickResult = cfg.cdpClickSendScript
      ? await evaluate(cdp, cfg.cdpClickSendScript, 4000)
      : await evaluate(cdp, CLICK_SEND_DEFAULT, 4000)
    logLine('click send: ' + clickResult)

    // Poll for response
    const pollDeadline = Date.now() + (cfg.timeoutMs || DEFAULT_TIMEOUT_MS)
    while (Date.now() < pollDeadline) {
      if (signal?.aborted) throw new Error('已取消')

      // Check if our message was sent
      try {
        const sent = await evaluate(cdp, sentCheckScript(baselineId, cfg.cdpMsgSelector), 4000)
        if (!sent?.sent) {
          await sleep(1000)
          continue
        }
      } catch { /* */ }

      // Check for response
      try {
        const result = await evaluate(cdp, lastMessageScript(baselineId, cfg.cdpMsgSelector), 4000)
        if (result?.phase === 'done' && result.text) {
          return result.text
        }
      } catch { /* */ }

      await sleep(1000)
    }

    throw new Error('CDP 识别超时：豆包未在规定时间内返回结果')
  } finally {
    cdp.close()
  }
}

// ── Backend dispatcher ──────────────────────────────────────────────────────

async function recognizeImage(filePath, question, cfg, signal) {
  // Check cache first
  const cache = getCache()
  const cached = cache.get(filePath, question)
  if (cached) {
    logLine('cache hit: ' + shortHash(fileHash(filePath)))
    return cached
  }

  // Dispatch to backend
  const backend = cfg.backend || 'api'
  let text

  if (backend === 'api') {
    text = await recognizeViaApi(filePath, question, cfg, signal)
  } else if (backend === 'cdp') {
    text = await recognizeViaCdp(filePath, question, cfg, signal)
  } else {
    throw new Error('未知的视觉后端: ' + backend + '（支持: api, cdp）')
  }

  // Cache the result
  cache.set(filePath, question, text)
  return text
}

// ── Image archival ───────────────────────────────────────────────────────────

function archiveImage(filePath) {
  try {
    mkdirSync(COLLECT_DIR, { recursive: true })
    const hash = fileHash(filePath)
    const ext = basename(filePath).split('.').pop() || 'png'
    const dest = join(COLLECT_DIR, todayStamp() + '_' + shortHash(hash) + '.' + ext)
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(filePath))
    }
  } catch (e) {
    logError('archiveImage', e)
  }
}

// ── LLM runtime patching ───────────────────────────────────────────────────

function addImageModality(info) {
  if (!info) return info
  if (Array.isArray(info.inputModalities)) {
    if (info.inputModalities.includes('image')) return info
    return { ...info, inputModalities: [...info.inputModalities, 'image'] }
  }
  return { ...info, inputModalities: ['text', 'image'] }
}

function stripImageBlocks(options) {
  const messages = options && options.messages
  if (!Array.isArray(messages)) return options
  let changed = false
  let imageCount = 0
  const sanitized = messages.map((m) => {
    if (!m || !Array.isArray(m.content) || !m.content.some((b) => b && b.type === 'image')) return m
    changed = true
    const textBlocks = m.content.filter((b) => !(b && b.type === 'image'))
    const imageBlocks = m.content.filter((b) => b && b.type === 'image')

    const paths = []
    for (const img of imageBlocks) {
      imageCount++
      const att = img.attachment
      if (att && att.attachmentId) {
        const hash = String(att.attachmentId).replace(/^sha256:/, '')
        if (hash.length >= 2) {
          const path = join(DSH_HOME, 'attachments', 'v1', 'objects', hash.slice(0, 2), hash)
          paths.push(path)
        }
      }
    }

    if (paths.length > 0) {
      textBlocks.push({
        type: 'text',
        text: '[用户发送了图片（' + paths.length + '张）。请使用 vision_recognize 工具识别图片内容，file_path 参数为：' + paths.join(' 或 ') + ']',
      })
    } else {
      textBlocks.push({
        type: 'text',
        text: '[用户发送了一张图片。请使用 vision_recognize 工具识别图片内容。]',
      })
    }
    return { ...m, content: textBlocks }
  })
  if (!changed) return options
  logLine('stream: stripped ' + imageCount + ' image blocks, added vision_recognize hint')
  return { ...options, messages: sanitized }
}

function patchAdapterStream(adapter) {
  if (!adapter || typeof adapter !== 'object' || adapter[PATCHED]) return
  if (typeof adapter.stream !== 'function') return
  const origStream = adapter.stream
  adapter.stream = function (options) {
    return origStream.call(this, stripImageBlocks(options))
  }
  adapter[PATCHED] = { stream: origStream }
}

function patchLlmRuntime(llm) {
  if (!llm || llm[PATCHED]) return
  const originals = {}
  let patchedAny = false

  if (typeof llm.resolveModelInfo === 'function') {
    originals.resolveModelInfo = llm.resolveModelInfo
    try {
      llm.resolveModelInfo = async function (...args) {
        const info = await originals.resolveModelInfo.apply(this, args)
        return addImageModality(info)
      }
      patchedAny = true
    } catch (e) { logError('patchLlmRuntime.resolveModelInfo', e) }
  }

  if (typeof llm.listModels === 'function') {
    originals.listModels = llm.listModels
    try {
      llm.listModels = async function (...args) {
        const models = await originals.listModels.apply(this, args)
        if (!Array.isArray(models)) return models
        return models.map((m) => addImageModality(m))
      }
      patchedAny = true
    } catch (e) { logError('patchLlmRuntime.listModels', e) }
  }

  if (typeof llm.stream === 'function') {
    originals.stream = llm.stream
    try {
      llm.stream = function (options) {
        return originals.stream.call(this, stripImageBlocks(options))
      }
      patchedAny = true
    } catch (e) { logError('patchLlmRuntime.stream', e) }
  }

  if (typeof llm.registerAdapter === 'function') {
    originals.registerAdapter = llm.registerAdapter
    try {
      llm.registerAdapter = function (providers, adapter) {
        patchAdapterStream(adapter)
        return originals.registerAdapter.call(this, providers, adapter)
      }
      patchedAny = true
    } catch (e) { logError('patchLlmRuntime.registerAdapter', e) }
  }

  if (patchedAny) {
    llm[PATCHED] = originals
    logLine('patched llm runtime: resolveModelInfo + listModels'
      + (originals.stream ? ' + stream' : '')
      + (originals.registerAdapter ? ' + registerAdapter' : ''))
  }
}

function restoreLlmRuntime() {
  try {
    if (!globalLlm) return
    const originals = globalLlm[PATCHED]
    if (!originals) return
    for (const name of Object.keys(originals)) {
      try { globalLlm[name] = originals[name] } catch (e) { logError('restoreLlmRuntime.' + name, e) }
    }
    try { delete globalLlm[PATCHED] } catch { /* */ }
  } catch (e) { logError('restoreLlmRuntime', e) }
}

// ── Plugin lifecycle ────────────────────────────────────────────────────────

const plugin = {
  name: 'vision-bridge',
  inject: ['tools'],

  apply(ctx, config) {
    globalConfig = {
      backend: config?.backend || 'api',
      apiKey: config?.apiKey || '',
      apiBase: config?.apiBase || '',
      apiModel: config?.apiModel || 'gpt-4o',
      cdpExePath: config?.cdpExePath || '',
      cdpPort: config?.cdpPort || DEFAULT_CDP_PORT,
      cdpAppUrlPrefix: config?.cdpAppUrlPrefix || 'doubao://doubao-chat/chat',
      cdpTextareaSelector: config?.cdpTextareaSelector || '',
      cdpUploadSelector: config?.cdpUploadSelector || '',
      cdpMsgSelector: config?.cdpMsgSelector || '',
      cdpClickSendScript: config?.cdpClickSendScript || '',
      timeoutMs: config?.timeoutMs || DEFAULT_TIMEOUT_MS,
      cacheDir: config?.cacheDir || CACHE_DIR,
      cacheMaxEntries: config?.cacheMaxEntries || 200,
    }

    logLine('apply: vision-bridge loaded (backend=' + globalConfig.backend + ')')

    // Ensure directories exist
    try {
      mkdirSync(join(DSH_HOME, 'plugins'), { recursive: true })
      mkdirSync(CACHE_DIR, { recursive: true })
    } catch { /* dirs may exist */ }

    // Patch LLM runtime to advertise image input modality and strip image blocks
    try {
      const llm = ctx.get('llm')
      if (llm) {
        globalLlm = llm
        patchLlmRuntime(llm)
      } else {
        logLine('WARNING: llm service not available at apply time')
      }
    } catch (e) {
      logError('apply: could not access llm service', e)
    }

    // Register tools
    try {
      ctx.tools.register({
        name: 'vision_recognize',
        description: '识别本地图片文件。当用户发送图片时必须调用此工具，不要用bash/ls/find查找文件。传入文件路径和可选的问题，返回图片描述或文字识别结果。工具运行在主机上，可以直接访问任何文件路径。',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: '本地图片文件路径（PNG/JPEG/GIF/WebP）' },
            question: {
              type: 'string',
              description: '想让视觉后端回答的问题（默认：详细描述图片内容）',
              default: DEFAULT_QUESTION,
            },
          },
          required: ['file_path'],
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: String(value) }]
          },
        },
        async execute(args, exec) {
          const q = args.question || DEFAULT_QUESTION
          logLine('tool vision_recognize: ' + args.file_path + ' q=' + q.slice(0, 50))
          archiveImage(args.file_path)
          const text = await recognizeImage(args.file_path, q, globalConfig, exec.signal)
          return text
        },
      })
    } catch (e) {
      logError('apply: could not register vision_recognize tool', e)
    }

    // System prompt injection: advertise the vision capability
    try {
      ctx.inject(['systemPrompt'], (promptCtx) => {
        promptCtx.systemPrompt.section({
          name: 'vision-bridge',
          order: -90,
          text: () =>
            '## Vision Tool (MANDATORY)\n\n'
            + 'When the user sends an image, you MUST immediately call the `vision_recognize` tool with the file path provided in the message. '
            + 'The tool runs on the host and can access any file path directly, including Windows paths like C:\\Users\\... and Linux paths.\n\n'
            + 'DO NOT use bash, ls, find, or any other tool to locate or read image files. '
            + 'The file path in the message is already correct and accessible by the vision_recognize tool.\n\n'
            + 'Example workflow:\n'
            + '- Message contains: "[用户发送了图片。请使用 vision_recognize 工具识别图片内容，file_path 参数为：C:\\\\Users\\\\...]"\n'
            + '- Your action: Call vision_recognize with file_path="C:\\\\Users\\\\..."\n'
            + '- The tool returns a text description of the image content\n',
        })
      })
    } catch (e) {
      logError('apply: could not inject system prompt', e)
    }

    // Cleanup on dispose
    patchRefs++
    return () => {
      patchRefs--
      if (patchRefs <= 0) {
        restoreLlmRuntime()
        logLine('dispose: vision-bridge unloaded')
      }
    }
  },
}

export { plugin as default }
