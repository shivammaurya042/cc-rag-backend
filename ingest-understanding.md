# Understanding `ingest.js`

The `ingest.js` script is a Node.js application responsible for processing documents, extracting information, and ingesting them into a Qdrant vector database. This process enables semantic search and Retrieval Augmented Generation (RAG) capabilities on the content of these documents.

## Core Functionality

The script performs the following major operations:

1.  **Document Loading & Parsing**:
    *   Supports PDF, Markdown (`.md`), and plain text (`.txt`) files.
    *   For PDF files, it utilizes **LlamaParse** (via LlamaCloud API) to convert PDF content into Markdown. This involves:
        *   Uploading the PDF to LlamaParse.
        *   Polling for job completion.
        *   Fetching the resulting Markdown.
    *   For Markdown and text files, it reads the content directly from the file system.

2.  **Content Chunking**:
    *   The extracted Markdown content (either from LlamaParse or direct .md files) is chunked hierarchically.
    *   It uses the `marked` library to lex the Markdown into tokens.
    *   Chunks are created based on headings (H1, H2, etc.). Each chunk aims to represent a coherent section of the document.
    *   Hierarchical context (e.g., "Main Section: [H1 Text]\nSub Section: [H2 Text]") is prepended to the chunk text before embedding to provide better context.
    *   Plain text files are currently processed as a single large chunk, though the code structure allows for different chunking strategies to be implemented.

3.  **Metadata Extraction**:
    *   Uses a Large Language Model (LLM), specifically Google's Gemini model (via `METADATA_EXTRACTION_MODEL_NAME` config), to extract structured metadata from the initial few chunks of the document.
    *   The LLM is prompted to provide:
        *   `document_title`
        *   `primary_entities`
        *   `summary`
        *   `security_classification` (e.g., "Confidential", "Internal", "Public")
        *   `keywords`
        *   `document_type` (e.g., "Credit Card Agreement", "Terms of Service", "FAQ")
        *   `language`
        *   `card_type_affinity` (e.g., "Travel Rewards", "Cashback", "Business", "General")
    *   This metadata is associated with every chunk derived from the document.

4.  **Embedding Generation**:
    *   For each processed chunk of text (with hierarchical context), vector embeddings are generated.
    *   This uses an OpenAI embedding model (specified by `EMBEDDING_MODEL_NAME` in `config.js`).

5.  **Data Storage (Upsert to Qdrant)**:
    *   The generated embeddings, along with their corresponding raw text and extensive metadata, are stored in a Qdrant vector database.
    *   Each chunk becomes a point in Qdrant, identified by a UUID.
    *   The payload for each point includes:
        *   `text`: The raw text of the chunk.
        *   `document_id`: A unique ID for the source document.
        *   `file_name`: The original name of the ingested file.
        *   `source_type`: 'pdf', 'md', or 'txt'.
        *   `chunk_type`: e.g., 'section_content'.
        *   `main_section_header`, `sub_section_header`: Headers associated with the chunk (if applicable).
        *   All metadata fields extracted by the LLM (title, summary, entities, etc.).

## Key Components and Modules

*   **Environment Variables & Configuration (`dotenv`, `config.js`)**:
    *   API keys (`LLAMA_CLOUD_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `QDRANT_API_KEY`).
    *   Service URLs (`QDRANT_URL`, `LLAMA_PARSE_BASE_URL`).
    *   Model names (`EMBEDDING_MODEL_NAME`, `METADATA_EXTRACTION_MODEL_NAME`).
    *   Qdrant collection name (`QDRANT_COLLECTION_NAME`).
*   **API Clients**:
    *   `axios`: For making HTTP requests to LlamaParse.
    *   `OpenAI`: For generating embeddings.
    *   `@qdrant/js-client-rest`: For interacting with Qdrant.
    *   `@google/generative-ai`: For metadata extraction using Gemini.
*   **Core Functions**:
    *   `startLlamaParseJob`, `pollJobStatus`, `getMarkdownResult`: Manage PDF parsing via LlamaParse.
    *   `chunkMarkdownByHierarchy`: Splits Markdown content into logical, hierarchically-aware chunks.
    *   `extractMetadataWithLLM`: Uses Gemini to get structured metadata.
    *   `getEmbeddings`: Generates text embeddings using OpenAI.
    *   `upsertToQdrant`: Stores data points in Qdrant.
    *   `processDocument`: Orchestrates the entire ingestion pipeline for a single document.
    *   `main`: The entry point of the script. It handles command-line arguments (file paths), initializes the Qdrant collection (creating it if it doesn't exist with the correct vector configuration), and processes each specified document.

## Execution Flow

1.  The script is run from the command line, providing paths to the documents to be ingested.
2.  It loads environment variables and configurations.
3.  It initializes all necessary API clients.
4.  The `main` function checks if the target Qdrant collection exists. If not, it creates it with the specified vector size (derived from the chosen embedding model) and distance metric.
5.  For each input file:
    a.  The `processDocument` function is called.
    b.  The file type is determined.
    c.  Content is fetched:
        *   PDFs are sent to LlamaParse for conversion to Markdown.
        *   MD/TXT files are read directly.
    d.  The content (now in Markdown format for PDFs and .md files) is chunked.
    e.  Document-level metadata is extracted using the Gemini model based on the first few chunks.
    f.  For each chunk:
        i.  An embedding vector is generated.
        ii. A Qdrant point is created with a unique ID, the vector, and a payload containing the raw chunk text, source information, chunk-specific headers, and the shared document-level metadata.
    g.  These points are then batch-upserted into the Qdrant collection.
6.  Progress and errors are logged to the console.

## Dependencies

*   `axios`: For HTTP requests.
*   `form-data`: For LlamaParse file uploads.
*   `marked`: For Markdown parsing and lexing.
*   `openai`: OpenAI API client.
*   `@qdrant/js-client-rest`: Qdrant client library.
*   `@google/generative-ai`: Google Generative AI client library.
*   `dotenv`: For loading environment variables.
*   `uuid`: For generating unique identifiers.
*   `fs`, `fs/promises`, `path`: Node.js built-in modules for file system operations.

## Error Handling

*   Checks for essential environment variables and configuration values at startup.
*   Includes try-catch blocks for API calls (LlamaParse, OpenAI, Google Gemini, Qdrant) and file operations.
*   LlamaParse polling includes a maximum attempt limit and timeout.
*   The main execution flow is wrapped in a try-catch block to handle unhandled errors.

This script provides a robust pipeline for transforming raw documents into a structured, searchable knowledge base within Qdrant, suitable for powering advanced AI applications.



## Architecture Diagram

```
+-----------------+      +-----------------+      +-----------------+
| Input Files     |----->| ingest.js       |<---->| Configuration   |
| (PDF, MD, TXT)  |      | (Node.js Script)|      | (.env, config.js)|
+-----------------+      +-----------------+      +-----------------+
                             |
                             | 1. Determine File Type
                             V
        +------------------------------------------+
        |             Document Parsing             |
        +------------------------------------------+
         |                |                      |
(PDF)    |          (Markdown)            (Text)   |
         V                V                      V
+-----------------+  +-----------------+   +----------------+
| LlamaParse API  |  | Direct Read     |   | Direct Read    |
| - Upload        |  | (fs)            |   | (fs)           |
| - Poll Status   |  +-----------------+   +----------------+
| - Get Markdown  |        |                     |
+-----------------+        | (Markdown Content)  | (Text Content)
         |                 |                     |
         +-------+---------+---------------------+
                 |
                 | 2. Content Processing
                 V
        +------------------------------------------+
        |          Content Chunking                |
        | (Hierarchical for Markdown/PDF-MD)       |
        | (Single/Custom for TXT)                  |
        +------------------------------------------+
                 | (Text Chunks)
                 |
                 | 3. Metadata Extraction (for first N chunks)
                 V
        +------------------------------------------+
        | Google Gemini API                        |
        | (Title, Entities, Summary, Keywords etc.)|
        +------------------------------------------+
                 | (Text Chunks + Document Metadata)
                 |
                 | 4. Embedding Generation
                 V
        +------------------------------------------+
        | OpenAI API                               |
        | (Embedding Model)                        |
        +------------------------------------------+
                 | (Vector Embeddings + Text Chunks + Metadata)
                 |
                 | 5. Data Storage
                 V
        +------------------------------------------+
        | Qdrant Vector Database                   |
        | - Create Collection (if not exists)      |
        | - Upsert Points (UUID, Vector, Payload)  |
        +------------------------------------------+

Payload for each Qdrant Point:
  - text: Raw chunk text
  - document_id: Unique ID for source document
  - file_name: Original file name
  - source_type: 'pdf', 'md', 'txt'
  - chunk_type: e.g., 'section_content'
  - main_section_header, sub_section_header
  - LLM-extracted metadata (title, summary, etc.)
```
