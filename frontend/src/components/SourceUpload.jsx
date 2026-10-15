import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FileUp,
  FileWarning,
  HardDrive,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react'

const ACCEPTED_TYPES = '.pdf,.txt,.md,.csv,.json'

function formatSize(bytes = 0) {
  if (!bytes) return 'Seed corpus'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value) {
  if (!value) return 'Built-in source'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export default function SourceUpload({
  sources,
  onUploadComplete,
  onDeleteSource,
  onReindexSource,
  onUpdateSource,
  isRefreshing,
}) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busyId, setBusyId] = useState('')
  const [openManageId, setOpenManageId] = useState('')
  const [selectedSource, setSelectedSource] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [editingSource, setEditingSource] = useState(false)
  const [editedContent, setEditedContent] = useState('')
  const [additionalContent, setAdditionalContent] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)

  useEffect(() => {
    if (!openManageId && !pendingDelete) return undefined
    const handleTransientUi = (event) => {
      if (event.type === 'keydown' && event.key === 'Escape') {
        setOpenManageId('')
        setPendingDelete(null)
      } else if (event.type === 'pointerdown' && !event.target.closest('.source-row-actions')) {
        setOpenManageId('')
      }
    }
    document.addEventListener('pointerdown', handleTransientUi)
    document.addEventListener('keydown', handleTransientUi)
    return () => {
      document.removeEventListener('pointerdown', handleTransientUi)
      document.removeEventListener('keydown', handleTransientUi)
    }
  }, [openManageId, pendingDelete])

  const uploadFiles = async (files) => {
    const selected = Array.from(files || [])
    if (!selected.length) return
    setError('')
    setSuccess('')
    setUploading(true)
    const outcomes = await Promise.allSettled(selected.map(async (file) => {
      const body = new FormData()
      body.append('file', file)
      const response = await fetch('/api/sources', { method: 'POST', body })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`${file.name}: ${payload.error || 'Upload failed.'}`)
      return payload
    }))
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason.message)
    const successes = outcomes.length - failures.length
    if (successes) {
      setSuccess(`${successes} ${successes === 1 ? 'source was' : 'sources were'} added and indexed locally.`)
      await onUploadComplete()
    }
    if (failures.length) setError(failures.join(' '))
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    uploadFiles(event.dataTransfer.files)
  }

  const showDetails = async (source) => {
    setSelectedSource(source)
    setEditingSource(false)
    setLoadingDetail(true)
    setError('')
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(source.sourceId)}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Could not load document details.')
      setSelectedSource(payload)
      return payload
    } catch (detailError) {
      setError(detailError.message)
      return null
    } finally {
      setLoadingDetail(false)
    }
  }

  const editSource = async (source) => {
    const details = await showDetails(source)
    if (!details) return
    setEditedContent(details.content || '')
    setAdditionalContent('')
    setEditingSource(true)
  }

  const saveSource = async () => {
    if (!selectedSource) return
    const content = additionalContent.trim()
      ? `${editedContent.trimEnd()}\n\n${additionalContent.trim()}`
      : editedContent
    setBusyId(selectedSource.sourceId)
    setError('')
    setSuccess('')
    try {
      const updated = await onUpdateSource(selectedSource.sourceId, content)
      setSelectedSource(updated)
      setEditedContent(updated.content || content)
      setAdditionalContent('')
      setEditingSource(false)
      setSuccess(`${selectedSource.title} was updated and re-indexed.`)
    } catch (updateError) {
      setError(updateError.message)
    } finally {
      setBusyId('')
    }
  }

  const deleteSource = async (source) => {
    setPendingDelete(null)
    setBusyId(source.sourceId)
    setError('')
    try {
      await onDeleteSource(source.sourceId)
      setSelectedSource(null)
      setSuccess(`${source.title} and its indexed passages were deleted.`)
    } catch (deleteError) {
      setError(deleteError.message)
    } finally {
      setBusyId('')
    }
  }

  const reindexSource = async (source) => {
    setBusyId(source.sourceId)
    setError('')
    setSuccess('')
    try {
      const result = await onReindexSource(source.sourceId)
      setSuccess(`${source.title} re-indexed into ${result.chunkCount} passages.`)
      if (selectedSource?.sourceId === source.sourceId) await showDetails(source)
    } catch (reindexError) {
      setError(reindexError.message)
    } finally {
      setBusyId('')
    }
  }

  return (
    <section className="sources-page">
      <div className="sources-header">
        <div>
          <div className="page-eyebrow"><FileUp size={15} /> KNOWLEDGE BASE</div>
          <h1>Your sources, in context.</h1>
          <p className="page-description">Manage source files and inspect the passages grounding each answer. Documents are stored privately on this machine.</p>
        </div>
        <div className="source-total"><strong>{sources.length}</strong><span>indexed sources</span></div>
      </div>

      <div className="source-management-grid">
        <section className="source-panel upload-panel" aria-labelledby="upload-sources-heading">
          <div className="source-panel-heading">
            <div><span className="source-panel-kicker">ADD TO KNOWLEDGE BASE</span><h2 id="upload-sources-heading">Upload new files</h2></div>
            <span className="source-panel-icon"><Upload size={16} /></span>
          </div>
          <p className="source-panel-description">Add documents to your private index for future answers.</p>
          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept={ACCEPTED_TYPES}
              multiple
              onChange={(event) => uploadFiles(event.target.files)}
            />
            <div className="upload-illustration"><Upload size={22} /></div>
            <h2>Bring your knowledge in.</h2>
            <p>Drag files here, or <button onClick={() => inputRef.current?.click()} disabled={uploading}>browse files</button></p>
            <div className="file-type-pills"><span>PDF</span><span>TXT</span><span>MD</span><span>CSV</span><span>JSON</span><i /><span>Up to 20 MB per file</span></div>
            {uploading && <div className="upload-progress"><LoaderCircle size={15} className="spin" /> Reading, chunking, and indexing your files…</div>}
      </div>

          {error && <div className="upload-feedback error" role="alert"><AlertCircle size={16} />{error}</div>}
          {success && <div className="upload-feedback success" role="status"><Check size={16} />{success}</div>}
        </section>

        <section className="source-panel indexed-panel" aria-labelledby="indexed-sources-heading">
          <div className="sources-list-header">
            <div className="source-panel-heading">
              <div><span className="source-panel-kicker">YOUR KNOWLEDGE BASE</span><h2 id="indexed-sources-heading">Uploaded documents</h2></div>
              <button className="refresh-button" onClick={onUploadComplete} disabled={isRefreshing}>
                <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} /> Refresh
              </button>
            </div>
            <p>Inspect, update, or remove your indexed files.</p>
          </div>

          <div className="sources-list">
            <div className="source-table-heading"><span>DOCUMENT</span><span>STATUS</span><span>CHUNKS</span><span>UPLOADED</span><span>SIZE</span><span>ACTIONS</span></div>
            {sources.length === 0 ? (
              <div className="sources-empty"><FileWarning size={21} /><strong>No indexed sources</strong><span>Upload a file above or wait for the Northstar policy corpus to load.</span></div>
            ) : sources.map((source) => (
          <article className="source-row source-table-row" key={source.sourceId} role="row">
            <button className="source-detail-trigger" onClick={() => showDetails(source)} aria-label={`View details for ${source.title}`}>
              <span className={`source-file-icon ${source.status === 'test_fixture' ? 'fixture' : ''}`}><FileText size={18} /></span>
              <span className="source-row-main">
                <span className="source-row-title">{source.title}<span className={`source-status ${source.status === 'test_fixture' ? 'fixture' : ''}`}>{source.status === 'test_fixture' ? 'TEST FIXTURE' : source.status === 'official' ? 'OFFICIAL' : 'UPLOADED'}</span></span>
                <span className="source-row-meta"><span>{source.documentId || source.sourceId}</span><span>·</span><span>{source.originalFilename || source.filename}</span></span>
              </span>
            </button>
            <span className="table-status">{source.status === 'official' ? 'Indexed' : source.status === 'test_fixture' ? 'Fixture' : 'Ready'}</span>
            <span className="table-value">{source.chunkCount} passages</span>
            <span className="table-value">{formatDate(source.uploadedAt)}</span>
            <span className="table-value">{formatSize(source.sizeBytes)}</span>
            <div className="source-row-actions">
              <button
                className={`source-manage-trigger ${openManageId === source.sourceId ? 'open' : ''}`}
                onClick={() => setOpenManageId(openManageId === source.sourceId ? '' : source.sourceId)}
                aria-label={`Manage ${source.title}`}
                aria-haspopup="menu"
                aria-expanded={openManageId === source.sourceId}
                disabled={busyId === source.sourceId}
              >
                {busyId === source.sourceId ? <LoaderCircle size={15} className="spin" /> : <MoreHorizontal size={16} />}
                <span>Manage</span>
              </button>
              {openManageId === source.sourceId && <div className="source-manage-menu" role="menu" aria-label={`Manage ${source.title}`}>
                <button role="menuitem" onClick={() => { setOpenManageId(''); editSource(source) }} disabled={busyId === source.sourceId}>
                  <FileText size={14} /> Update data
                </button>
                <button role="menuitem" className="delete-menu-item" onClick={() => { setOpenManageId(''); setPendingDelete(source) }} disabled={!source.removable || busyId === source.sourceId}>
                  <Trash2 size={14} /> Delete file
                </button>
              </div>}
            </div>
            <button
              className="source-detail-arrow"
              onClick={() => showDetails(source)}
              aria-label={`Open details for ${source.title}`}
              title={`Open ${source.title}`}
            >
              <ChevronRight size={16} className="source-chevron" />
            </button>
          </article>
            ))}
          </div>
        </section>
      </div>

      <div className="source-note"><ShieldCheck size={17} /><p><strong>Local-first document handling.</strong> Original uploads, SQLite metadata, chunk text, and optional ChromaDB vectors stay on this machine. Test fixtures remain visibly marked and are never presented as official policy.</p></div>
      <div className="source-footnote"><CircleHelp size={13} /> Northstar University documents are synthetic and intended for RAG development only.</div>

      {selectedSource && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedSource(null) }}>
        <aside className="source-drawer" role="dialog" aria-modal="true" aria-label={`${selectedSource.title} document details`}>
          <div className="drawer-header">
            <div><span className="drawer-eyebrow"><FileText size={13} /> SOURCE DETAIL</span><h2>{selectedSource.title}</h2></div>
            <button className="drawer-close" onClick={() => setSelectedSource(null)} aria-label="Close document details"><X size={18} /></button>
          </div>
          {loadingDetail ? <div className="drawer-loading"><LoaderCircle size={19} className="spin" /> Loading original document…</div> : <>
            <div className="drawer-meta-grid">
              <div><span>DOCUMENT ID</span><strong>{selectedSource.documentId || selectedSource.sourceId}</strong></div>
              <div><span>STATUS</span><strong>{selectedSource.status === 'official' ? 'Official corpus' : selectedSource.status === 'test_fixture' ? 'Non-official test fixture' : 'Uploaded source'}</strong></div>
              <div><span>ORIGINAL FILE</span><strong>{selectedSource.originalFilename || selectedSource.filename}</strong></div>
              <div><span>FILE SIZE</span><strong>{formatSize(selectedSource.sizeBytes)}</strong></div>
              <div><span><CalendarDays size={12} /> UPLOADED</span><strong>{formatDate(selectedSource.uploadedAt)}</strong></div>
              <div><span><HardDrive size={12} /> INDEXED PASSAGES</span><strong>{selectedSource.chunkCount}</strong></div>
            </div>
            <div className="drawer-actions">
              {!editingSource && <button className="drawer-reindex" onClick={() => editSource(selectedSource)} disabled={busyId === selectedSource.sourceId}>
                <FileText size={15} /> Edit text
              </button>}
              {selectedSource.reindexable && <button className="drawer-reindex" onClick={() => reindexSource(selectedSource)} disabled={busyId === selectedSource.sourceId}>
                {busyId === selectedSource.sourceId ? <LoaderCircle size={15} className="spin" /> : <RotateCw size={15} />} Re-index
              </button>}
              {selectedSource.removable && <button className="drawer-delete" onClick={() => setPendingDelete(selectedSource)} disabled={busyId === selectedSource.sourceId}>
                <Trash2 size={15} /> Delete source
              </button>}
            </div>
            {editingSource ? <>
              <label className="source-editor-label" htmlFor="source-text-editor">Document text</label>
              <textarea
                id="source-text-editor"
                className="source-text-editor"
                value={editedContent}
                onChange={(event) => setEditedContent(event.target.value)}
                maxLength={20 * 1024 * 1024}
                disabled={busyId === selectedSource.sourceId}
              />
              <label className="source-editor-label" htmlFor="source-text-append">Append additional text (optional)</label>
              <textarea
                id="source-text-append"
                className="source-text-editor source-text-append"
                value={additionalContent}
                onChange={(event) => setAdditionalContent(event.target.value)}
                placeholder="Add information to the end of this document…"
                disabled={busyId === selectedSource.sourceId}
              />
              <div className="drawer-actions source-editor-actions">
                <button className="drawer-reindex" onClick={() => setEditingSource(false)} disabled={busyId === selectedSource.sourceId}>Cancel</button>
                <button className="drawer-reindex" onClick={saveSource} disabled={busyId === selectedSource.sourceId || (!editedContent.trim() && !additionalContent.trim())}>
                  {busyId === selectedSource.sourceId ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Save and re-index
                </button>
              </div>
            </> : <>
              <div className="drawer-section-title"><span>INDEXED CHUNKS</span><span>{selectedSource.chunks?.length || 0}</span></div>
              <div className="drawer-chunks">{selectedSource.chunks?.map((chunk) => (
                <article className="drawer-chunk" key={chunk.chunkId}>
                  <div className="chunk-topline"><strong>{chunk.sectionHeading || 'Document'}</strong><span>{chunk.pageNumber ? `Page ${chunk.pageNumber}` : 'Passage'}</span></div>
                  <p>{chunk.text}</p>
                </article>
              ))}</div>
            </>}
          </>}
          <div className="drawer-footer"><Clock3 size={13} /> Save updates the indexed text and its passages. Re-index refreshes from the retained original file.</div>
        </aside>
      </div>}

      {pendingDelete && <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingDelete(null) }}>
        <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-description">
          <span className="confirm-icon"><Trash2 size={18} /></span>
          <h2 id="delete-confirm-title">Delete this source?</h2>
          <p id="delete-confirm-description">“{pendingDelete.title}” and its original file, indexed passages, and stored vectors will be permanently removed from this workspace.</p>
          <div className="confirm-actions">
            <button className="confirm-cancel" onClick={() => setPendingDelete(null)}>Cancel</button>
            <button className="confirm-delete" onClick={() => deleteSource(pendingDelete)}><Trash2 size={14} /> Delete file</button>
          </div>
        </section>
      </div>}
    </section>
  )
}
