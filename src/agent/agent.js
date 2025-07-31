import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { DynamicTool } from "@langchain/core/tools"; // To ensure type compatibility if needed
import { config } from "../config.js";
import { createSearchTool } from "./tools.js";

const AGENT_MODEL_NAME = config.agentModelName;
const SYSTEM_PROMPT_TEMPLATE = `You are a helpful AI assistant specialized in answering questions about Credit Card.
You have access to tools to help you retrieve information.

Your goal is to accurately answer user questions based ONLY on the information retrieved from the credit card documents using the available tools.

Conversation History:
{chat_history}

User Query:
{input}

RULES:
1.  Examine the user's query and the conversation history carefully.
2.  Determine if the user is asking about a specific, valid credit card. Check the list of valid cards your tool knows about if unsure.
3.  If a *single*, valid credit card is clearly identified (in the query or history), identify the core question/topic. Plan to use the "search_credit_card_info" tool with the correct 'card_name' and 'search_query'.
4.  When using the "search_credit_card_info" tool, pass the 'card_name' with "Credit Card" or "Debit Card" as suffix, by default keep "Credit Card". 
5.  If NO valid card name is mentioned, or the query is ambiguous (mentions multiple valid cards, compares cards, asks about an invalid card), DO NOT use the search tool. Instead, respond directly to the user asking them to clarify which *single*, specific, valid card they want information about. You can list the card name that you think user is asking about, but never list complete card names.
6.  If the user asks a comparative question, explain that you can only look up information for one card at a time and ask them to specify which card to start with.
7.  When you use the "search_credit_card_info" tool, carefully review ALL the results provided. Synthesize the relevant information from MULTIPLE results if they contribute to answering the user's query comprehensively. Formulate your final answer based ONLY on the information returned by the tool. Quote or summarize the key findings accurately, potentially drawing from several snippets.
8.  If the tool returns an error (e.g., invalid card name, search failure) or finds no information, state that clearly to the user. Do not invent information.
9.  If the user's query is conversational or off-topic, respond naturally without attempting to use the search tool.
10. The response that you get form the tool, format it in structured manner, with proper line breaks and bullet points.

Carefully consider the rules before deciding whether to call a tool or respond directly. Structure your tool call input correctly as a JSON object with "card_name" and "search_query".`;


let agentExecutor = null;

export async function getAgentExecutor() {
    if (agentExecutor) {
        return agentExecutor;
    }

    try {
        const llm = new ChatGoogleGenerativeAI({
            apiKey: config.googleApiKey,
            model: AGENT_MODEL_NAME,
            temperature: 0.2,
        });

        const tools = await createSearchTool(); // Returns an array: [searchCreditCardTermsTool]

        const prompt = ChatPromptTemplate.fromMessages([
            ["system", SYSTEM_PROMPT_TEMPLATE],
            new MessagesPlaceholder("chat_history"), // History is crucial context
            ["human", "{input}"],
            new MessagesPlaceholder("agent_scratchpad"), // Still needed for Langchain's internal tool calling message format
        ]);

        // **USE createToolCallingAgent**
        const agent = await createToolCallingAgent({
            llm,
            tools,
            prompt,
        });

        agentExecutor = new AgentExecutor({
            agent,
            tools,
            verbose: true, // Keep verbose for debugging, set to false for production
            // handleParsingErrors: true, // Good for robustness
        });

        console.log("Tool Calling Agent Executor created successfully.");
        return agentExecutor;

    } catch (error) {
        console.error("FATAL ERROR: Failed to create Agent Executor:", error);
        throw new Error("Agent creation failed.");
    }
}