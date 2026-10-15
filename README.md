# Northstar University RAG Assistant

A local-first, source-grounded policy assistant built with React, Vite, Tailwind CSS, Express, FastAPI, and SQLite. The provided synthetic Northstar University corpus is loaded automatically: its 10 official documents are indexed at startup, while evaluation data and the deliberately conflicting test fixture are kept out of the default index.

## Run locally

Requirements: Node.js 20+, Python 3.10–3.14 for the optional ChromaDB/Sentence-Transformers extras (Python 3.15 can run the built-in SQLite/local-search fallback), and npm.

From this directory:

```powershell
npm install
python -m pip install -r requirements.txt
npm run dev
```

Open <http://127.0.0.1:5173>. The development command starts the FastAPI RAG service, Express API, and Vite frontend together. The SQLite-backed index and local lexical-vector fallback work without a model download or external API key.

### Optional ChromaDB and Sentence-Transformers

On Python 3.10–3.14, install the optional vector-store and embedding packages from `requirements.txt`. The service uses a locally cached `all-MiniLM-L6-v2` model when available, then stores its vectors in persistent ChromaDB. The model is never downloaded automatically; to allow it to be loaded from Hugging Face on a machine with internet access, set `HF_HUB_OFFLINE=0` and warm the model cache before starting the service. Without a cached model, retrieval transparently uses the SQLite-backed TF-IDF cosine fallback.

To download/cache the embedding model intentionally:

```powershell
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
```

ChromaDB is stored in `backend/data/chroma/`. SQLite document metadata and indexed passages are stored in `backend/data/ragchat.sqlite3`; uploaded originals are stored in `backend/data/uploads/`. Keep these paths on persistent, access-controlled storage for a long-running deployment.

### Optional local SLM with Ollama

Install [Ollama](https://ollama.com/), then pull the default Nemotron chat model:

```powershell
ollama pull nemotron-mini
```

An Ollama embedding model is optional. If you want Ollama-based vector embeddings, pull:

```powershell
ollama pull nomic-embed-text
```

Keep Ollama running and restart the app. The default chat model is `nemotron-mini:latest`; set `OLLAMA_CHAT_MODEL` to choose another installed chat model. Chat and embedding models are detected independently. The service uses a cached Sentence-Transformers model first, then Ollama embeddings if the configured embedding model is installed, otherwise the SQLite-backed local fallback. Configure `OLLAMA_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`, `SENTENCE_TRANSFORMER_MODEL`, `USE_SENTENCE_TRANSFORMERS`, `PORT`, or `RAG_DATA_DIR` with environment variables.

## Features

- Search the official seed policies and upload PDF/TXT/MD/CSV/JSON files. Source management includes metadata, full document/chunk detail, re-indexing, and deletion of both the retained original and its indexed passages.
- The expandable, single-bar citation summary reports cosine similarity as a percentage. Expanded citations include document ID, title, original filename, page (where available), detected section heading, status, and the supporting excerpt.
- Uploaded files are limited to 20 MB. SQLite is the authoritative persistent metadata/chunk store; ChromaDB persists embeddings when its optional dependencies are installed.
- Chat sessions and the recent-chat list are stored in the browser's local storage.
- The evaluation questions are not loaded as documents. The conflict fixture stays excluded unless a user explicitly uploads it, and is marked as a non-official test fixture.
- The fictional nature of the dataset is surfaced in the interface and source metadata.

Policy questions are answered from retrieved passages only. The assistant will not fill gaps in university rules with model guesses. A general-knowledge answer is used only when an Ollama chat model is configured and the question is outside the university-policy domain; the UI labels it clearly and warns that it is not independently verified. Language models cannot guarantee 100% factual accuracy, so verify consequential information against authoritative sources.

For a production deployment, configure authentication, TLS, a restrictive `FRONTEND_ORIGIN`, durable backups, malware scanning, and access controls for uploaded documents. The included profile is a local UI demo, not an authentication system.
