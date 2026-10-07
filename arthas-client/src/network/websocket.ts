import { encode, decode } from '@msgpack/msgpack'
import { MSG_PING, MSG_PONG, type Message } from './protocol'

// ===== 配置 =====

/**
 * 📚 学习要点: 相对 WebSocket URL 的自动推导
 * 自托管模式下，前端和后端通过同一域名访问（Go 服务器同时服务两者）。
 * 通过 location.protocol 和 location.host 自动构建 WebSocket URL：
 * - HTTPS 页面 -> wss://（加密 WebSocket）
 * - HTTP 页面 -> ws://（非加密 WebSocket）
 * 这消除了构建时注入 VITE_WS_URL 的需求，换域名无需重新构建镜像。
 *
 * 优先级链：connect(url) 参数 > VITE_WS_URL 环境变量 > getDefaultWsUrl() 推导
 * - 开发模式：.env.development 设置 VITE_WS_URL，指向本地后端
 * - Vercel 部署：.env.production 设置 VITE_WS_URL，指向 HF Spaces 后端
 * - 自托管模式：不设置 VITE_WS_URL，自动使用相对 URL（同域访问）
 */
export function getDefaultWsUrl(): string {
  // SSR 或测试环境中 window 不存在，回退到 localhost 默认值
  if (typeof window === 'undefined') {
    return 'ws://localhost:8080/ws'
  }
  // 根据页面协议推导 WebSocket 协议：HTTPS -> wss, HTTP -> ws
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

const DEFAULT_WS_URL = getDefaultWsUrl()
const BACKOFF_INITIAL_MS = 1000
const BACKOFF_MAX_MS = 30000

// ===== 状态 =====

let ws: WebSocket | null = null
let connected = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 重连成功后的回调。
 *
 * 📚 学习要点: 传输层恢复 ≠ 回到房间
 * 服务器在连接断开时就把客户端移出了房间（其他成员会收到 MemberLeft）。
 * 重新建立 WebSocket 只恢复了传输通道，服务端并不知道我们还想待在原来的
 * 房间里 —— 必须重新发送 JoinRoom。
 *
 * 手机切到别的 App 时 iOS Safari 会断开 WebSocket，回到前台后重连，
 * 过去只是重连了通道，对端始终显示我们已离开。
 */
let reconnectHandler: (() => void) | null = null

/** 标记是否已经成功连接过；之后的每次 onopen 都属于「重连」。 */
let hasConnectedOnce = false
let backoff = BACKOFF_INITIAL_MS
let messageHandler: ((msg: Message) => void) | null = null
let shouldReconnect = true

// ===== 公开 API =====

/**
 * 发起 WebSocket 连接。
 *
 * 幂等设计：如果已存在活跃连接，先关闭旧连接再创建新连接。
 * 这确保 React StrictMode 的双重 mount 不会产生孤儿连接。
 *
 * @param url 可选，覆盖默认 URL
 */
export function connect(url?: string): void {
  const wsUrl = url ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL
  shouldReconnect = true

  // 关闭已有连接，防止 StrictMode 或重复调用产生孤儿 WebSocket
  if (ws) {
    const oldWs = ws
    ws = null
    oldWs.onclose = null // 阻止旧连接的 onclose 触发重连逻辑
    oldWs.onerror = null
    oldWs.onmessage = null
    oldWs.close()
  }

  try {
    ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      console.log('[WS] Connected')
      connected = true
      backoff = BACKOFF_INITIAL_MS // 重置退避

      // 首次连接由调用方自己决定何时 join；此后每次 onopen 都是重连，
      // 需要重新加入房间，否则对端会一直认为我们已经离开。
      if (hasConnectedOnce) {
        reconnectHandler?.()
      }
      hasConnectedOnce = true
    }

    ws.onmessage = (event: MessageEvent) => {
      handleRawMessage(event.data)
    }

    ws.onclose = () => {
      console.log('[WS] Disconnected')
      connected = false
      ws = null
      if (shouldReconnect) {
        scheduleReconnect(wsUrl)
      }
    }

    ws.onerror = (err) => {
      console.error('[WS] Error:', err)
    }
  } catch (err) {
    console.error('[WS] Connection failed:', err)
    connected = false
    ws = null
    if (shouldReconnect) {
      scheduleReconnect(url ?? import.meta.env.VITE_WS_URL ?? DEFAULT_WS_URL)
    }
  }
}

/**
 * 主动关闭连接，不再自动重连。
 */
/**
 * 注册重连后的回调（用于重新加入房间）。
 * 首次连接不会触发，只有真正的重连才会。
 */
export function onReconnect(handler: (() => void) | null): void {
  reconnectHandler = handler
}

export function disconnect(): void {
  // 主动断开：下一次 connect() 视为首次连接，不应触发重新加入。
  hasConnectedOnce = false
  shouldReconnect = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
}

/**
 * 发送消息。将 {type, data} 信封用 MessagePack 编码后以二进制发送。
 */
export function send(type: number, data: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const msg: Message = { type, data }
  const encoded = encode(msg)
  ws.send(encoded)
}

/**
 * 注册消息处理回调。收到服务器消息后会调用此 handler。
 */
export function onMessage(handler: (msg: Message) => void): void {
  messageHandler = handler
}

/**
 * 返回当前连接状态。
 */
export function isConnected(): boolean {
  return connected
}

/**
 * 返回底层 WebSocket 实例（调试/高级用途）。
 */
export function getWs(): WebSocket | null {
  return ws
}

// ===== 内部逻辑 =====

/**
 * 处理收到的原始二进制消息：解码 → 处理 Ping → 分发给 handler。
 */
function handleRawMessage(raw: ArrayBuffer): void {
  try {
    const msg = decode(new Uint8Array(raw)) as Message

    // 自动回复 Ping
    if (msg.type === MSG_PING) {
      const pingData = msg.data as { t: number }
      send(MSG_PONG, { t: pingData.t })
      return
    }

    // 分发给注册的 handler
    if (messageHandler) {
      messageHandler(msg)
    }
  } catch (err) {
    console.error('[WS] Failed to decode message:', err)
  }
}

/**
 * 指数退避重连调度。
 * 退避序列：1s → 2s → 4s → 8s → 16s → 30s (max)
 */
function scheduleReconnect(url: string): void {
  if (reconnectTimer) return

  console.log(`[WS] Reconnecting in ${backoff / 1000}s...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // 增长退避时间（下次使用）
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    connect(url)
  }, backoff)
}
