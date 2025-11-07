import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
} from '@adiwajshing/baileys'
import Pino from 'pino'
import fs from 'fs'
import path from 'path'
import response from './response.js'

const SESSIONS_DIR = path.resolve('sessions')
const sessions = new Map()
const stores = new Map()
const logger = Pino({ level: process.env.WA_LOG_LEVEL ?? 'silent' })

const ensureSessionsDir = async () => {
    await fs.promises.mkdir(SESSIONS_DIR, { recursive: true })
}

const getSessionDir = (id, isLegacy) => {
    const prefix = isLegacy ? 'legacy' : 'md'
    return path.join(SESSIONS_DIR, `${prefix}_${id}`)
}

const formatPhone = (value = '') => {
    if (!value) {
        return ''
    }

    if (value.includes('@')) {
        return value
    }

    let formatted = value.trim().replace(/[^0-9]/g, '')

    if (formatted.startsWith('00')) {
        formatted = formatted.slice(2)
    }

    if (formatted.startsWith('0')) {
        formatted = formatted.slice(1)
    }

    return `${formatted}@s.whatsapp.net`
}

const formatGroup = (value = '') => {
    if (!value) {
        return ''
    }

    if (value.includes('@g.us')) {
        return value
    }

    let formatted = value.trim().replace(/[^0-9-]/g, '')
    return `${formatted}@g.us`
}

const startSession = async (id, isLegacy, res = undefined, restoring = false) => {
    await ensureSessionsDir()

    const sessionDir = getSessionDir(id, isLegacy)
    await fs.promises.mkdir(sessionDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const chatStore = new Map()
    stores.set(id, chatStore)

    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        logger,
        browser: Browsers.macOS('Safari'),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        markOnlineOnConnect: false,
        syncFullHistory: false,
    })

    sock.isLegacy = isLegacy
    sock.sessionId = id

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('chats.set', ({ chats }) => {
        for (const chat of chats ?? []) {
            chatStore.set(chat.id, chat)
        }
    })

    sock.ev.on('chats.upsert', (chats) => {
        for (const chat of chats ?? []) {
            chatStore.set(chat.id, chat)
        }
    })

    sock.ev.on('chats.update', (updates) => {
        for (const update of updates ?? []) {
            const existing = chatStore.get(update.id) ?? {}
            chatStore.set(update.id, { ...existing, ...update })
        }
    })

    let responded = false
    const respondOnce = (statusCode, success, message, data = {}) => {
        if (!res || responded) {
            return
        }

        responded = true
        response(res, statusCode, success, message, data)
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            respondOnce(200, true, 'Scan the QR code to authenticate.', { id, isLegacy, qr })
        }

        if (connection === 'open') {
            sessions.set(id, sock)
            respondOnce(200, true, 'Session connected.', { id, isLegacy })
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode
            const shouldLogOut = reason === DisconnectReason.loggedOut

            if (shouldLogOut) {
                sessions.delete(id)
                stores.delete(id)
                respondOnce(401, false, 'Session logged out.')
            }

            if (!shouldLogOut) {
                setTimeout(() => {
                    startSession(id, isLegacy, undefined, true).catch((error) => logger.error({ error }, 'Failed to restart session'))
                }, 2000)

                respondOnce(503, false, 'Connection interrupted, attempting to reconnect.')
            }
        }
    })

    if (restoring) {
        sessions.set(id, sock)
    }

    return sock
}

const init = async () => {
    await ensureSessionsDir()

    const entries = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true })

    const tasks = entries
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => {
            const name = dirent.name
            if (name.startsWith('md_')) {
                const id = name.replace('md_', '')
                return startSession(id, false, undefined, true)
            }

            if (name.startsWith('legacy_')) {
                const id = name.replace('legacy_', '')
                return startSession(id, true, undefined, true)
            }

            return Promise.resolve()
        })

    await Promise.all(tasks)
}

const cleanup = async () => {
    const closures = []

    for (const [id, session] of sessions.entries()) {
        closures.push(
            session
                .logout()
                .catch(() => undefined)
                .finally(() => {
                    sessions.delete(id)
                    stores.delete(id)
                }),
        )
    }

    await Promise.allSettled(closures)
}

const isSessionExists = (id) => sessions.has(id)

const getSession = (id) => {
    const session = sessions.get(id)
    if (!session) {
        throw new Error(`Session ${id} not found`)
    }

    return session
}

const createSession = async (id, isLegacy, res) => {
    if (!id || typeof id !== 'string') {
        return response(res, 400, false, 'A valid session id is required.')
    }

    try {
        await startSession(id, isLegacy, res)
    } catch (error) {
        logger.error({ error, id }, 'Failed to create session')
        response(res, 500, false, 'Failed to create the WhatsApp session.')
    }
}

const deleteSession = async (id, isLegacy, removeDir = true) => {
    const session = sessions.get(id)

    if (session) {
        try {
            await session.logout()
        } catch (error) {
            logger.warn({ error, id }, 'Error logging out session during deletion')
        }

        try {
            session.end?.()
        } catch (error) {
            logger.warn({ error, id }, 'Error closing session socket during deletion')
        }
    }

    sessions.delete(id)
    stores.delete(id)

    if (removeDir) {
        const sessionDir = getSessionDir(id, isLegacy)
        await fs.promises.rm(sessionDir, { recursive: true, force: true })
    }
}

const getChatList = (id) => {
    const chatStore = stores.get(id)
    if (!chatStore) {
        return []
    }

    try {
        return Array.from(chatStore.values()).map((chat) => ({
            id: chat.id,
            name: chat.name,
            unreadCount: chat.unreadCount,
        }))
    } catch (error) {
        logger.warn({ error, id }, 'Failed to read chat list')
        return []
    }
}

const isExists = async (session, jid) => {
    try {
        const result = await session.onWhatsApp(jid)
        return Array.isArray(result) && result.some((entry) => entry.exists)
    } catch (error) {
        logger.warn({ error, jid }, 'Failed to verify WhatsApp existence')
        return false
    }
}

const sendMessage = async (session, receiver, message, delay = 0) => {
    if (delay && Number.isFinite(delay) && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
    }

    return session.sendMessage(receiver, { text: message })
}

export {
    cleanup,
    createSession,
    deleteSession,
    formatGroup,
    formatPhone,
    getChatList,
    getSession,
    init,
    isExists,
    isSessionExists,
    sendMessage,
}

