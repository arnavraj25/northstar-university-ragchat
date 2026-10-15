const path = require('node:path')
const fs = require('node:fs')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const multer = require('multer')
const { rateLimit } = require('express-rate-limit')

const app = express()
const PORT = Number(process.env.PORT || 4000)
const RAG_URL = (process.env.RAG_URL || 'http://127.0.0.1:8001').replace(/\/$/, '')
const MAX_FILE_SIZE = 20 * 1024 * 1024

app.disable('x-powered-by')
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173' }))
app.use(express.json({ limit: '20mb' }))
app.use('/api/chat', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = path.extname(file.originalname).toLowerCase()
    if (!['.pdf', '.csv', '.txt', '.md', '.json'].includes(extension)) {
      callback(new Error('Unsupported file type. Upload a PDF, TXT, MD, CSV, or JSON file.'))
      return
    }
    callback(null, true)
  },
})

async function ragRequest(endpoint, options = {}) {
  const response = await fetch(`${RAG_URL}${endpoint}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 30_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.detail || body.error || `RAG service returned ${response.status}.`)
    error.status = response.status
    throw error
  }
  return body
}

app.get('/api/health', async (_req, res) => {
  try {
    const status = await ragRequest('/health', { timeout: 2500 })
    res.json({ api: 'online', ...status })
  } catch {
    res.status(503).json({ api: 'online', rag: 'offline', error: 'The RAG service is not responding.' })
  }
})

app.get('/api/sources', async (_req, res, next) => {
  try {
    res.json(await ragRequest('/sources'))
  } catch (error) {
    next(error)
  }
})

app.post('/api/chat', async (req, res, next) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  if (!question || question.length > 2000) {
    res.status(400).json({ error: 'Enter a question of 1 to 2,000 characters.' })
    return
  }
  try {
    const result = await ragRequest('/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, session_id: req.body.sessionId || null }),
      timeout: 120_000,
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
})

app.post('/api/sources', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    res.status(400).json({ error: 'Choose a PDF, CSV, or TXT file to upload.' })
    return
  }
  try {
    const body = new FormData()
    body.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname)
    const result = await ragRequest('/ingest', { method: 'POST', body, timeout: 120_000 })
    res.status(201).json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/sources/:sourceId', async (req, res, next) => {
  try {
    res.json(await ragRequest(`/sources/${encodeURIComponent(req.params.sourceId)}`))
  } catch (error) {
    next(error)
  }
})

app.put('/api/sources/:sourceId', async (req, res, next) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (!content.trim()) {
    res.status(400).json({ error: 'Document text cannot be empty.' })
    return
  }
  try {
    res.json(await ragRequest(`/sources/${encodeURIComponent(req.params.sourceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      timeout: 120_000,
    }))
  } catch (error) {
    next(error)
  }
})

app.post('/api/sources/:sourceId/reindex', async (req, res, next) => {
  try {
    res.json(await ragRequest(`/sources/${encodeURIComponent(req.params.sourceId)}/reindex`, { method: 'POST' }))
  } catch (error) {
    next(error)
  }
})

app.delete('/api/sources/:sourceId', async (req, res, next) => {
  try {
    res.json(await ragRequest(`/sources/${encodeURIComponent(req.params.sourceId)}`, { method: 'DELETE' }))
  } catch (error) {
    next(error)
  }
})

const frontendDist = path.resolve(__dirname, '..', 'frontend', 'dist')
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) {
      res.sendFile(path.join(frontendDist, 'index.html'))
      return
    }
    next()
  })
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. The maximum size is 20 MB.'
      : error.message
    res.status(400).json({ error: message })
    return
  }
  if (error.message?.startsWith('Unsupported file type')) {
    res.status(415).json({ error: error.message })
    return
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    res.status(504).json({ error: 'The local RAG service took too long to respond. Please try again.' })
    return
  }
  const status = error.status || 502
  res.status(status).json({ error: error.status ? error.message : 'The local RAG service is unavailable. Start it with npm run dev.' })
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Northstar API listening on http://127.0.0.1:${PORT}`)
})
