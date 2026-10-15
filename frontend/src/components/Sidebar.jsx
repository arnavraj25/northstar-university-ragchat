import { useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileStack,
  GraduationCap,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  Settings2,
  Sparkles,
} from 'lucide-react'

function formatDate(timestamp) {
  const date = new Date(timestamp)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function Sidebar({ activeView, onViewChange, onNewChat, history, activeSessionId, onHistorySelect, sourceCount, health }) {
  const [historyOpen, setHistoryOpen] = useState(true)

  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-mark"><GraduationCap size={19} strokeWidth={2.1} /></div>
        <div className="brand-name">northstar<span className="brand-dot">.</span><small>UNIVERSITY</small></div>
      </div>

      <button className="new-chat-button" onClick={onNewChat}><Plus size={16} strokeWidth={2.4} /> New conversation <span>⌘ K</span></button>

      <div className="sidebar-section">
        <button className="section-heading" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
          <span>YOUR CHATS</span>{historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {historyOpen && <div className="chat-history-list">
          {history.length ? history.map((chat) => (
            <button key={chat.id} className={`history-item ${activeSessionId === chat.id ? 'active' : ''}`} onClick={() => onHistorySelect(chat.id)}>
              <MessageSquareText size={15} /><span className="history-title">{chat.title}</span><time>{formatDate(chat.updatedAt)}</time>
            </button>
          )) : <p className="history-empty"><Clock3 size={14} /> Your conversations will appear here</p>}
        </div>}
      </div>

      <div className="sidebar-section data-section">
        <div className="section-heading static-heading"><span>KNOWLEDGE BASE</span></div>
        <button className={`nav-item ${activeView === 'sources' ? 'active' : ''}`} onClick={() => onViewChange('sources')}>
          <FileStack size={17} /><span>Sources</span><span className="nav-count">{sourceCount}</span>
        </button>
        <button className={`nav-item ${activeView === 'admin' ? 'active' : ''}`} onClick={() => onViewChange('admin')}>
          <LayoutDashboard size={17} /><span>Workspace</span>
        </button>
      </div>

      <div className="sidebar-bottom">
        <div className="index-health">
          <span className={`health-dot ${health?.rag === 'online' ? 'online' : ''}`} />
          <span>{health?.rag === 'online' ? 'Local index ready' : 'Connecting to local index'}</span>
        </div>
        <div className="sidebar-rule" />
        <button className="sidebar-help" onClick={() => onViewChange('admin')}><CircleHelp size={16} /> Help & workspace</button>
        <div className="sidebar-user">
          <div className="user-avatar">A</div>
          <div className="user-details"><strong>University Auditor</strong><span>auditor@example.com</span></div>
          <Settings2 size={16} className="user-settings" />
        </div>
        <div className="sidebar-version"><Sparkles size={12} /> PRIVATE AI WORKSPACE <BookOpen size={12} /></div>
      </div>
    </aside>
  )
}
