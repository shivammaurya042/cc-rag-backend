import 'dotenv/config';
import { LlamaIndex } from 'llamaindex';
import { Pinecone } from '@pinecone-database/pinecone';

// Initialize LlamaIndex
const llama = new LlamaIndex({
  apiKey: process.env.OPENAI_API_KEY,
  embeddingsModel: 'text-embedding-ada-002',
});

// Initialize Pinecone
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// Search Pinecone for relevant documents
async function retrieveDocuments(query) {
  const embedding = await llama.getEmbeddings(query);
  const response = await index.query({ vector: embedding, topK: 3, includeMetadata: true });
  return response.matches.map(match => match.metadata.text).join("\n");
}

// Generate a response using retrieved context
export async function askQuestion(question) {
  console.log("🔍 Retrieving relevant documents...");
  const context = await retrieveDocuments(question);

  const prompt = `Use the following context to answer the question:\n\n${context}\n\nQuestion: ${question}\nAnswer:`;
  
  const response = await llama.generate(prompt);
  console.log("\n💡 AI Response:", response.text);
}
