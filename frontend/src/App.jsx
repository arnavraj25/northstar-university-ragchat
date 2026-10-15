import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRight,
  BrainCircuit,
  BookOpen,
  CircleHelp,
  Database,
  FileCheck2,
  FileText,
  GitBranch,
  GraduationCap,
  LoaderCircle,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react'
import Sidebar from './components/Sidebar.jsx'
import ChatArea from './components/ChatArea.jsx'
import SourceUpload from './components/SourceUpload.jsx'

const HISTORY_KEY = 'northstar-rag-history-v1'
const SESSION_KEY = 'northstar-rag-session-v1'

function readStored(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function makeSession() {
  return { id: crypto.randomUUID(), title: 'New conversation', messages: [], updatedAt: Date.now() }
}

function App() {
  const [history, setHistory] = useState(() => readStored(HISTORY_KEY, []))
  const [session, setSession] = useState(() => readStored(SESSION_KEY, null) || makeSession())
  const [activeView, setActiveView] = useState('chat')
  const [pipelineView, setPipelineView] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia('(min-width: 701px)').matches)
  const [health, setHealth] = useState(null)
  const [sources, setSources] = useState([])
  const [loadingSources, setLoadingSources] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 30)))
  }, [history])

  useEffect(() => {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  }, [session])

  const refreshStatus = useCallback(async () => {
    try {
      const [healthResponse, sourceResponse] = await Promise.all([
        fetch('/api/health'),
        fetch('/api/sources'),
      ])
      if (healthResponse.ok) setHealth(await healthResponse.json())
      if (sourceResponse.ok) setSources((await sourceResponse.json()).sources || [])
    } catch {
      setHealth(null)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    const timer = window.setInterval(refreshStatus, 30000)
    return () => window.clearInterval(timer)
  }, [refreshStatus])

  const saveSession = useCallback((updated) => {
    setSession(updated)
    if (updated.messages.length) {
      setHistory((current) => {
        const rest = current.filter((item) => item.id !== updated.id)
        return [{ id: updated.id, title: updated.title, updatedAt: updated.updatedAt }, ...rest].slice(0, 30)
      })
    }
  }, [])

  const startNewChat = () => {
    setSession(makeSession())
    setActiveView('chat')
    setPipelineView(false)
    if (window.matchMedia('(max-width: 700px)').matches) setSidebarOpen(false)
    setNotice('')
  }

  const openHistory = (id) => {
    setActiveView('chat')
    setPipelineView(false)
    if (window.matchMedia('(max-width: 700px)').matches) setSidebarOpen(false)
    const saved = readStored(`northstar-chat-${id}`, null)
    if (saved) {
      setSession(saved)
      return
    }
    if (id === session.id) return
    setNotice('This chat is no longer available in this browser.')
    window.setTimeout(() => setNotice(''), 3500)
  }

  useEffect(() => {
    if (session.messages.length) localStorage.setItem(`northstar-chat-${session.id}`, JSON.stringify(session))
  }, [session])

  const updateSources = async () => {
    setLoadingSources(true)
    try {
      const response = await fetch('/api/sources')
      if (!response.ok) throw new Error('Could not refresh the source list.')
      setSources((await response.json()).sources || [])
    } catch (error) {
      setNotice(error.message)
    } finally {
      setLoadingSources(false)
    }
  }

  const handleDeleteSource = async (sourceId) => {
    const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'The source could not be removed.')
    await updateSources()
    await refreshStatus()
  }

  const handleReindexSource = async (sourceId) => {
    const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}/reindex`, { method: 'POST' })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'The source could not be re-indexed.')
    await updateSources()
    await refreshStatus()
    return payload
  }

  const handleUpdateSource = async (sourceId, content) => {
    const response = await fetch(`/api/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || 'The source could not be updated.')
    await updateSources()
    await refreshStatus()
    return payload
  }

  const handleUploadComplete = async () => {
    await updateSources()
    await refreshStatus()
  }

  const appendMessages = (messages) => {
    const firstQuestion = messages.find((message) => message.role === 'user')?.content
    const title = session.messages.length ? session.title : (firstQuestion || 'New conversation').slice(0, 54)
    saveSession({ ...session, title, messages, updatedAt: Date.now() })
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <Sidebar
          activeView={activeView}
          onViewChange={(view) => {
            setActiveView(view)
            setPipelineView(false)
            if (window.matchMedia('(max-width: 700px)').matches) setSidebarOpen(false)
          }}
          onNewChat={startNewChat}
          history={history}
          activeSessionId={session.id}
          onHistorySelect={openHistory}
          sourceCount={sources.length}
          health={health}
        />
      )}
      {sidebarOpen && <button className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-label="Close navigation" />}

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
              {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
            <div className="breadcrumb"><span>Northstar University</span><span className="breadcrumb-divider">/</span><strong>{activeView === 'sources' ? 'Sources' : activeView === 'admin' ? 'Workspace' : pipelineView ? 'Knowledge flow' : 'Assistant'}</strong></div>
          </div>
          <div className="topbar-actions">
            <div className="view-switch" aria-label="Workspace view">
              <button className={!pipelineView && activeView === 'chat' ? 'selected' : ''} onClick={() => { setActiveView('chat'); setPipelineView(false) }}><Sparkles size={14} /> Chat</button>
              <button className={pipelineView ? 'selected' : ''} onClick={() => { setActiveView('chat'); setPipelineView(true) }}><GitBranch size={14} /> Flow</button>
            </div>
            <button className="profile-button" title="Signed in as auditor@example.com">
              <span className="profile-avatar">A</span>
              <span className="profile-name">Auditor</span>
              <span className="profile-chevron">⌄</span>
            </button>
          </div>
        </header>

        <div className="main-content">
          {notice && <div className="toast" role="status">{notice}</div>}
          {activeView === 'sources' ? (
            <SourceUpload
              sources={sources}
              onUploadComplete={handleUploadComplete}
              onDeleteSource={handleDeleteSource}
              onReindexSource={handleReindexSource}
              onUpdateSource={handleUpdateSource}
              isRefreshing={loadingSources}
            />
          ) : pipelineView ? (
            <PipelineBoard
              health={health}
              sourceCount={sources.length}
              lastQuery={[...session.messages].reverse().find((message) => message.role === 'user')?.content}
              citationCount={[...session.messages].reverse().find((message) => message.role === 'assistant')?.citations?.length || 0}
            />
          ) : activeView === 'admin' ? (
            <WorkspaceView health={health} sourceCount={sources.length} onSources={() => setActiveView('sources')} />
          ) : (
            <ChatArea
              key={session.id}
              session={session}
              onMessagesChange={appendMessages}
              health={health}
              sourceCount={sources.length}
              onSources={() => setActiveView('sources')}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function PipelineBoard({ health, sourceCount, lastQuery, citationCount }) {
  const localEmbeddings = /sqlite|tf-idf|fallback/i.test(health?.embeddingMode || '')
  const steps = [
    { icon: MessageSquareText, title: 'User query', detail: lastQuery || 'Waiting for your next question', state: lastQuery ? 'ready' : 'idle', tag: lastQuery ? 'QUERY RECEIVED' : 'AWAITING INPUT' },
    { icon: Sparkles, title: 'Embedding service', detail: health?.embeddingMode || 'Local embedding service', state: health?.rag === 'online' ? localEmbeddings ? 'local' : 'ready' : 'idle', tag: health?.rag !== 'online' ? 'CONNECTING' : localEmbeddings ? 'LOCAL SERVICE' : 'SERVICE READY' },
    { icon: Database, title: 'Vector retrieval', detail: health?.vectorStore || 'ChromaDB vector retrieval', state: health?.rag === 'online' && sourceCount ? 'ready' : 'idle', tag: `${sourceCount} SOURCES` },
    { icon: SearchCheck, title: 'Evidence grounding', detail: 'Ranked passages + policy system prompt', state: lastQuery && sourceCount ? 'ready' : 'idle', tag: 'SOURCE-GROUNDED' },
    { icon: BrainCircuit, title: 'LLM generation', detail: health?.model || 'Local evidence answer engine', state: health?.ollama ? 'ready' : 'local', tag: health?.ollama ? 'MODEL READY' : 'LOCAL MODE' },
    { icon: FileCheck2, title: 'Validated citations', detail: citationCount ? `${citationCount} source${citationCount === 1 ? '' : 's'} attached to the latest answer` : 'Source references are checked before display', state: citationCount ? 'ready' : 'idle', tag: citationCount ? `${citationCount} CITATIONS` : 'TRACEABLE OUTPUT' },
  ]
  return (
    <section className="pipeline-page">
      <div className="page-eyebrow"><GitBranch size={15} /> LIVE RETRIEVAL PIPELINE</div>
      <h1>Follow the flow of evidence.</h1>
      <p className="page-description">See each stage between your question and a source-grounded response.</p>
      <div className="flow-live-status"><span className={`flow-live-dot ${health?.rag === 'online' ? 'online' : ''}`} />{health?.rag === 'online' ? 'PIPELINE CONNECTED' : 'CONNECTING TO LOCAL SERVICES'}<span className="flow-live-divider" />{sourceCount} indexed sources</div>
      <div className="pipeline-track">
        {steps.map((step, index) => {
          const Icon = step.icon
          return <div className="pipeline-step-wrap" key={step.title}>
            <article className={`pipeline-node ${step.state}`} aria-label={`${step.title}: ${step.tag}`}>
              <div className="pipeline-node-top"><span className={`step-icon ${step.state}`}><Icon size={19} /></span><span className="step-number">0{index + 1}</span></div>
              <h2>{step.title}</h2>
              <p>{step.detail}</p>
              <span className={`pipeline-node-tag ${step.state}`}><i />{step.tag}</span>
            </article>
            {index < steps.length - 1 && <div className="pipeline-connector" aria-hidden="true"><svg viewBox="0 0 46 18" preserveAspectRatio="none"><defs><marker id={`flow-arrow-${index}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" /></marker></defs><path className="connector-track" d="M2 9 H42" markerEnd={`url(#flow-arrow-${index})`} /><path className="connector-pulse" d="M2 9 H42" /></svg><ArrowRight className="connector-mobile-arrow" size={15} /></div>}
          </div>
        })}
      </div>
      {lastQuery && <div className="flow-query-preview"><MessageSquareText size={15} /><span><strong>Latest query</strong>{lastQuery}</span></div>}
      <div className="pipeline-note"><ShieldCheck size={18} /><span><strong>Privacy by design.</strong> Documents and conversations stay on this machine. Vector retrieval runs through {health?.vectorStore || 'the local index'}; Ollama is optional.</span></div>
    </section>
  )
}

function WorkspaceView({ health, sourceCount, onSources }) {
  return (
    <section className="workspace-page">
      <div className="page-eyebrow"><ShieldCheck size={15} /> WORKSPACE</div>
      <h1>Your knowledge, at a glance.</h1>
      <p className="page-description">A private workspace for answers grounded in Northstar University's fictional policy corpus.</p>
      <div className="workspace-cards">
        <article className="workspace-card"><span className="workspace-icon lavender"><FileText size={20} /></span><span className="metric-label">INDEXED SOURCES</span><strong>{sourceCount}</strong><span className="metric-foot">official university documents</span></article>
        <article className="workspace-card"><span className="workspace-icon green"><Sparkles size={20} /></span><span className="metric-label">ANSWER ENGINE</span><strong className="status-value">{health?.ollama ? 'Ollama ready' : 'Local mode'}</strong><span className="metric-foot">{health?.ollama ? health.model : 'Source-backed fallback is active'}</span></article>
        <article className="workspace-card"><span className="workspace-icon amber"><BookOpen size={20} /></span><span className="metric-label">RETRIEVAL</span><strong className="status-value">{health?.rag === 'online' ? 'Online' : 'Connecting'}</strong><span className="metric-foot">{health?.embeddingMode || 'TF-IDF vector similarity'}</span></article>
      </div>
      <button className="primary-button workspace-cta" onClick={onSources}><Upload size={16} /> Manage sources</button>
      <div className="workspace-disclaimer"><CircleHelp size={16} /><span>This is a synthetic training dataset. Policies and details are fictional and should not be used for real-world decisions.</span></div>
    </section>
  )
}

export default App
