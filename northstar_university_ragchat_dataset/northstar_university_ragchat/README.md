# Northstar University RAGChat Dummy Dataset

**All organizations, policies, dates, amounts, and details in this dataset are fictional.**
This dataset is intended for beginner-level RAG (retrieval-augmented generation) development and testing only.

## Contents

- `documents/`: 10 plain-text fictional university documents.
- `documents.json`: All 10 documents with stable IDs, metadata, and full content.
- `document_index.csv`: Small index mapping document IDs to filenames and metadata.
- `evaluation_questions.json`: 30 beginner-level evaluation tests with expected answers, source IDs, and expected behaviors.
- `test_fixtures/TEST-CONFLICT-001.txt`: Deliberately conflicting tuition fee snippet, clearly marked as a test fixture and not an official policy.
- `conflict_test_fixture.json`: Metadata and full content for the conflict fixture.
- `README.md`: This file.

## Document IDs

- `UNI-001`: Attendance Policy
- `UNI-002`: Examination Rules
- `UNI-003`: Grading and Assessment Policy
- `UNI-004`: Course Registration Policy
- `UNI-005`: Tuition Fee and Payment Policy
- `UNI-006`: Scholarship Policy
- `UNI-007`: Student Leave and Absence Procedure
- `UNI-008`: Library and Campus Facilities Guide
- `UNI-009`: Student Code of Conduct
- `UNI-010`: Academic Calendar 2026–27

## Suggested beginner workflow

1. Load the 10 files from `documents/` or load `documents.json`.
2. Split document text into chunks (for example, 400–700 tokens with a small overlap).
3. Preserve metadata such as `document_id`, `title`, `category`, and `version` on every chunk.
4. Embed chunks and store them in a vector index.
5. For a question, retrieve the top 3–5 chunks and pass those chunks to the LLM as the only permitted evidence.
6. Require answers to cite source document IDs.
7. If retrieved evidence does not answer the question, say the documents do not specify the answer rather than inventing facts.
8. Evaluate against `evaluation_questions.json`.
9. For contradiction testing only, add `test_fixtures/TEST-CONFLICT-001.txt` to a separate test index. Keep it out of the default official-policy corpus.

## Example JSON structure

Each document in `documents.json` includes:
- `document_id`
- `title`
- `category`
- `version`
- `effective_date`
- `status`
- `content`

## Basic acceptance criteria

- Correct direct answers cite the right source IDs.
- Multi-fact questions retrieve all required facts.
- Missing-information questions do not result in invented answers.
- The test fixture is identified as non-official and conflicts with `UNI-005`.
- The assistant distinguishes official documents from test fixtures.

## Example questions to try

- What is the minimum attendance required for regular end-semester exams?
- What is the standard undergraduate tuition fee per semester?
- What is the exact hostel fee refund percentage?
- When does the first semester begin?
- If I submit a medical certificate, will my attendance shortage definitely be waived?

## Suggested answer instruction for the RAG chatbot

"Answer only using the supplied retrieved context. Cite the document ID for every policy claim. If the context does not contain the requested information, say that the documents do not specify it. Do not guess. If sources conflict, explain the conflict, cite all relevant document IDs, and prefer an official document over a clearly labelled test fixture. Do not treat test fixtures as official policy."

## Important

This is a synthetic training corpus, not real academic, legal, or financial advice. Do not use these fictional policies to make real-world decisions.
