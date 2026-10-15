import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GraduationCap,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  UserRound,
} from 'lucide-react'

const suggestions = [
  { icon: GraduationCap, label: 'What is the minimum attendance required for exams?', tag: 'ATTENDANCE' },
  { icon: BookOpen, label: 'What are the scholarship eligibility criteria?', tag: 'FINANCIAL AID' },
  { icon: FileText, label: 'When does the first semester begin?', tag: 'ACADEMIC CALENDAR' },
]

export default function ChatArea({ session, onMessagesChange, health, sourceCount, onSources }) {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [copiedIndex, setCopiedIndex] = useState(-1)
  const [feedbackIndex, setFeedbackIndex] = useState(-1)
  const textareaRef = useRef(null)
  const bottomRef = useRef(null)
  const messages = session.messages
  const isEmpty = messages.length === 0

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, sending])

  const submit = async (event) => {
    event?.preventDefault()
    const question = input.trim()
    if (!question || sending) return
    setInput('')
    setError('')
    const pendingMessages = [...messages, { role: 'user', content: question, createdAt: Date.now() }]
    onMessagesChange(pendingMessages)
    setSending(true)
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sessionId: session.id }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'The assistant could not answer right now.')
      onMessagesChange([...pendingMessages, {
        role: 'assistant',
        content: payload.answer,
        citations: payload.citations || [],
        answerType: payload.answerType || 'unsupported',
        retrievalMode: payload.retrievalMode,
        model: payload.model,
        createdAt: Date.now(),
      }])
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const copyAnswer = async (content, index) => {
    await navigator.clipboard.writeText(content)
    setCopiedIndex(index)
    window.setTimeout(() => setCopiedIndex(-1), 1800)
  }

  return (
    <div className={`chat-layout ${isEmpty ? 'empty-chat' : 'active-chat'}`}>
      <div className="chat-scroll-area">
        {isEmpty ? (
          <div className="welcome">
            <div className="welcome-orbit">
              <span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" />
              <div className="welcome-icon"><GraduationCap size={29} strokeWidth={1.7} /></div>
              <span className="orbit-sparkle"><Sparkles size={15} /></span>
            </div>
            <div className="welcome-kicker"><span /> NORTHSTAR POLICY ASSISTANT</div>
            <h1>Clarity starts<br />with <span>the right question.</span></h1>
            <p className="welcome-copy">Explore university policies, academic dates, and student services. Every answer is grounded in your source documents.</p>
            <div className="suggestion-grid">
              {suggestions.map(({ icon: Icon, label, tag }) => (
                <button key={label} className="suggestion-card" onClick={() => { setInput(label); textareaRef.current?.focus() }}>
                  <span className="suggestion-tag">{tag}</span><span className="suggestion-label">{label}</span><span className="suggestion-icon"><Icon size={17} /></span>
                </button>
              ))}
            </div>
            {sourceCount === 0 && <button className="empty-source-link" onClick={onSources}><Plus size={14} /> Add policy documents to get started</button>}
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message, index) => (
              <article className={`message-row ${message.role}`} key={`${message.createdAt || index}-${index}`}>
                <div className={`message-avatar ${message.role}`}>
                  {message.role === 'user' ? <UserRound size={17} /> : <span className="assistant-avatar-mark"><Sparkles size={16} /></span>}
                </div>
                <div className="message-body">
                  <div className="message-meta"><strong>{message.role === 'user' ? 'You' : 'Northstar Assistant'}</strong>{message.role === 'assistant' && <span className={`grounded-badge ${message.answerType || 'official_sources'}`}><ShieldCheck size={12} />{message.answerType === 'general_knowledge' ? 'GENERAL KNOWLEDGE' : message.answerType === 'unsupported' ? 'NO VERIFIED SOURCE' : message.answerType === 'mixed_sources' ? 'OFFICIAL + TEST SOURCE' : message.answerType === 'indexed_sources' ? 'INDEXED SOURCES' : 'OFFICIAL SOURCES'}</span>}</div>
                  <div className="message-content">{message.role === 'assistant'
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    : <p>{message.content}</p>}
                  </div>
                  {message.role === 'assistant' && (
                    <>
                      <Citations citations={message.citations || []} answerType={message.answerType || 'unsupported'} />
                      <div className="answer-actions">
                        <button onClick={() => copyAnswer(message.content, index)}>{copiedIndex === index ? <Check size={14} /> : <Plus size={14} />} {copiedIndex === index ? 'Copied' : 'Copy answer'}</button>
                        <button className={feedbackIndex === index ? 'feedback-selected' : ''} onClick={() => setFeedbackIndex(index)} title="Mark as helpful"><ThumbsUp size={14} /> Helpful</button>
                        {message.model && <span className="answer-model">{message.model}</span>}
                      </div>
                    </>
                  )}
                </div>
              </article>
            ))}
            {sending && <div className="message-row assistant"><div className="message-avatar assistant"><span className="assistant-avatar-mark"><Sparkles size={16} /></span></div><div className="message-body"><div className="message-meta"><strong>Northstar Assistant</strong><span className="grounded-badge"><ShieldCheck size={12} /> SEARCHING SOURCES</span></div><div className="thinking"><LoaderCircle size={16} className="spin" /><span>Reviewing the policy documents…</span></div></div></div>}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="composer-area">
        {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
        <form className="composer" onSubmit={submit}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a university policy, date or process…"
            aria-label="Ask the Northstar policy assistant"
            disabled={sending}
          />
          <div className="composer-footer">
            <div className="composer-hint"><ShieldCheck size={13} /><span>Answers grounded in <strong>{sourceCount} sources</strong></span><span className="hint-separator">·</span><span>{health?.ollama ? `Powered by ${health.model}` : 'Private local mode'}</span></div>
            <button className="send-button" type="submit" aria-label="Send message" disabled={!input.trim() || sending}>
              {sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} strokeWidth={2.4} />}
            </button>
          </div>
        </form>
        <p className="disclaimer">Northstar University is fictional. Verify important information with official university staff.</p>
      </div>
    </div>
  )
}

function Citations({ citations, answerType }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="citations-box">
      <button className="citations-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="citation-heading-icon"><BookOpen size={14} /></span>
        <span className="citation-heading-text"><strong>{citations.length ? 'RETRIEVED FILE CITATIONS' : answerType === 'general_knowledge' ? 'GENERAL KNOWLEDGE · NO FILE CITATIONS' : 'SOURCE CHECK'}</strong><small>{citations.length ? `${citations.length} ${citations.length === 1 ? 'source' : 'sources'} · click for supporting passages` : answerType === 'general_knowledge' ? 'This answer is not based on university documents' : 'No relevant indexed evidence was found'}</small></span>
        <span className="citation-count">{citations.length}</span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <div className="citation-list">{citations.length ? citations.map((citation, index) => (
        <article className="citation-item" key={`${citation.sourceId}-${citation.page || 'doc'}-${index}`}>
          <span className="citation-document-icon"><FileText size={15} /></span>
          <div className="citation-details">
            <div className="citation-source-title">{citation.title}<span className={`source-status ${citation.status === 'test_fixture' ? 'fixture' : ''}`}>{citation.status === 'test_fixture' ? 'TEST FIXTURE · NOT OFFICIAL' : citation.status === 'official' ? 'OFFICIAL' : 'UPLOADED SOURCE'}</span></div>
            <div className="citation-source-meta"><span>Document ID: {citation.documentId || citation.sourceId}</span><span>·</span><span>Original file: {citation.originalFilename || citation.filename}</span>{(citation.pageNumber || citation.page) && <><span>·</span><span>Page {citation.pageNumber || citation.page}</span></>}</div>
            <div className="citation-section">Section: {citation.sectionHeading || 'Document'}</div>
            {citation.excerpt && <p className="citation-excerpt">“{citation.excerpt}”</p>}
          </div>
        </article>
      )) : <div className="citation-empty">{answerType === 'general_knowledge' ? 'This response uses general model knowledge, not official Northstar University documents. Verify important or current information independently.' : 'The indexed documents do not support a verified answer to this question.'}</div>}</div>}
    </div>
  )
}
