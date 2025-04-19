import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { AgentExecutor, createReactAgent } from "langchain/agents"; // Using ReAct agent type
import { DynamicTool } from "@langchain/core/tools"; // To ensure type compatibility if needed
import { config } from "../config.js";
import { createSearchTool } from "./tools.js";

// --- Agent Configuration ---
const SYSTEM_PROMPT_TEMPLATE = `You are a helpful AI assistant specialized in answering questions about Credit Card Terms & Conditions (T&Cs).
You have access to a tool called "search_credit_card_terms".

Your goal is to accurately answer user questions based ONLY on the information retrieved from the T&Cs using the tool.

Available tools:
{tools} // Provided by Langchain Agent Executor

Tool descriptions:
{tool_names} // Provided by Langchain Agent Executor

Conversation History (if any):
{chat_history}

Current User Query:
{input}

RULES:
1.  PRIORITY: ALWAYS check the conversation history first for context. The user might be referring to a card mentioned earlier.
2.  IDENTIFY INTENT & ENTITIES: Determine the user's goal (e.g., lookup specific info, compare cards) and extract relevant entities like card names and the specific topic/feature being asked about.
3.  VALIDATE CARD NAMES: Check extracted card names against the known valid list provided in the tool description.
4.  PLANNING - SINGLE CARD: If the query clearly refers to exactly ONE valid card (from query or history) and asks for specific information, plan to use the 'search_credit_card_terms' tool once with the correct 'card_name' and the 'search_query' (the topic/feature).
5.  PLANNING - COMPARISON: If the query explicitly asks to compare features of TWO OR MORE valid cards:
    a. Identify all the valid card names involved in the comparison.
    b. Identify the specific feature/topic being compared (e.g., "reward rate", "annual fee").
    c. Plan to call the 'search_credit_card_terms' tool **sequentially**, once for **each** valid card name involved. Use the *same* 'search_query' (the feature being compared) for each tool call.
    d. After receiving results from all necessary tool calls, synthesize the information to provide a comparative answer based ONLY on the retrieved text. Clearly state which information belongs to which card.
6.  PLANNING - CLARIFICATION: If NO valid card name is mentioned, or the query is ambiguous about which *single* card is intended (and it's not a comparison), DO NOT use the tool. Respond by asking the user to clarify which *single*, specific, valid card they want information about. If the card name is ambiguous, list the cards that matches closely to the card mentioned and ask user if he means any of those .
7.  TOOL USAGE: Only use the 'search_credit_card_terms' tool when you have identified a specific, valid card name and the topic to search for. Ensure the input to the tool is a JSON object with "card_name" and "search_query".
8.  ANSWER SYNTHESIS: Base your final answer ONLY on the information returned by the tool(s). If the tool returns an error or finds no information for a card, state that clearly in your response. Do not make up information. If comparing, explicitly state if information for one of the cards could not be found.
9.  ERROR HANDLING: If the tool returns an error like 'Invalid card name', inform the user. If an internal tool error occurs, inform the user you couldn't complete the search.
10. CONVERSATIONAL QUERIES: If the user's query is conversational or off-topic, remind user that you can only help in queries regarding credit cards.
11. Be concise and directly address the user's request based on the retrieved information or the need for clarification.

Begin!

Thought: // Agent's internal reasoning process starts here
{agent_scratchpad}`; // Placeholder for agent's intermediate steps

let agentExecutor = null;

export async function getAgentExecutor() {
    if (agentExecutor) {
        return agentExecutor;
    }

    if (!config.googleApiKey) {
        console.error("FATAL ERROR in getAgentExecutor: config.googleApiKey is undefined.");
        throw new Error("Google API Key is missing. Check environment variables and .env file.");
    }

    try {
        const llm = new ChatGoogleGenerativeAI({
            apiKey: config.googleApiKey,
            model: config.agentModelName,
            temperature: 0.2, // Lower temperature for more deterministic planning/response
        });

        const tools = await createSearchTool();

        const prompt = ChatPromptTemplate.fromMessages([
            ["system", SYSTEM_PROMPT_TEMPLATE],
            new MessagesPlaceholder("chat_history"), // Placeholder for history messages
            ["human", "{input}"],
            new MessagesPlaceholder("agent_scratchpad"), // Placeholder for agent's intermediate steps
        ]);

        const agent = await createReactAgent({ // Using ReAct agent suitable for chat + tools
            llm,
            tools,
            prompt,
        });

        agentExecutor = new AgentExecutor({
            agent,
            tools,
            verbose: true, // Set to true for debugging agent steps, false for production
            // handleParsingErrors: true, // Optionally handle LLM output parsing errors more gracefully
        });

        console.log("Agent Executor created successfully.");
        return agentExecutor;

    } catch (error) {
        console.error("FATAL ERROR: Failed to create Agent Executor:", error);
        throw new Error("Agent creation failed.");
    }
}