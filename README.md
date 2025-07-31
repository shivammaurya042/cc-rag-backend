# Credit Card Information RAG Application

This project is a Retrieval-Augmented Generation (RAG) application designed to answer questions about various credit cards. It leverages a vector database and large language models (LLMs) to provide accurate and context-aware responses based on a knowledge base of credit card documents.

## Features

- **RAG-based Question Answering**: Utilizes a RAG pipeline to retrieve relevant information and generate human-like answers.
- **Vector Search**: Employs a vector database for efficient similarity search on credit card features and benefits.
- **LLM Integration**: Powered by advanced LLMs for natural language understanding and response generation.
- **Conversation History**: Maintains session history to provide contextual responses in an ongoing conversation.
- **Scalable Architecture**: Built with Node.js and Express, making it scalable and robust.
- **Observability**: Integrated with LangSmith for tracing and monitoring.

## Tech Stack

- **Backend**: Node.js, Express
- **Language Models**: Google Gemini, OpenAI
- **Vector Database**: Qdrant
- **In-memory Storage**: Redis
- **Parsing**: LlamaParse
- **Core Libraries**: LangChain.js, dotenv, winston

## Project Structure

```
credit-card-rag/
├── data/ # Directory for raw data files (e.g., PDFs)
├── ingest.js # Script for data ingestion, processing, and embedding
├── src/
│   ├── agent/ # Contains the agent logic and tools
│   │   ├── agent.js # Core agent setup and initialization
│   │   └── tools.js # Custom tools for the agent (e.g., credit card search)
│   ├── utils/ # Utility functions
│   │   └── logger.js # Winston logger configuration
│   ├── config.js # Application configuration
│   ├── redisClient.js # Redis client setup
│   └── server.js # Express server and API endpoints
├── validCards.json # List of supported credit cards
├── .env # Environment variable configurations
├── package.json # Project dependencies and scripts
└── README.md # This file
```

## Setup and Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd credit-card-rag
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory and add the necessary API keys and configuration values. See the `.env.example` file for a template.

   - `GEMINI_API_KEY`: Your Google Gemini API key.
   - `OPENAI_API_KEY`: Your OpenAI API key.
   - `QDRANT_URL`: URL for your Qdrant instance.
   - `QDRANT_API_KEY`: Your Qdrant API key.
   - `REDIS_URL`: Your Redis connection URL.
   - `LANGSMITH_TRACING`: Set to "true" to enable LangSmith tracing.
   - `LANGSMITH_API_KEY`: Your LangSmith API key.

## Usage

1. **Ingest Data:**
   Run the ingestion script to process your credit card documents and populate the vector database.
   ```bash
   node ingest.js
   ```

2. **Start the server:**
   ```bash
   npm start
   ```
   The server will start on the port specified in your configuration (default is 3000).

3. **Send a query:**
   Make a POST request to the `/chat` endpoint with a JSON body containing your message and session ID.
   ```http
   POST /chat HTTP/1.1
   Host: localhost:3000
   Content-Type: application/json

   {
     "message": "What are the benefits of the HDFC Millennia credit card?",
     "sessionId": "some-unique-session-id"
   }
   ```
