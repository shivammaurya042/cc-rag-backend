import fs from 'fs/promises';
import { config } from '../config.js';

let validCards = null;

export async function loadValidCards() {
    if (validCards) {
        return validCards;
    }
    try {
        console.log(`Loading valid cards from: ${config.validCardsPath}`);
        const data = await fs.readFile(config.validCardsPath, 'utf-8');
        validCards = JSON.parse(data);
        if (!Array.isArray(validCards)) {
            throw new Error('validCards.json is not a JSON array.');
        }
        console.log(`Loaded ${validCards.length} valid card names.`);
        return validCards;
    } catch (error) {
        console.error(`FATAL ERROR: Could not load or parse ${config.validCardsPath}:`, error);
        // Decide if the app should exit or run without validation
        process.exit(1); // Exit if card list is critical
        // return []; // Or return empty array if you want to allow running without validation
    }
}