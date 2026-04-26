const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize the AI Agent
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/parse', auth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: 'Prompt required' });

    // Use the flash model for ultra-low latency
    const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash-latest", // 🚀 Added "-latest" right here
  generationConfig: { responseMimeType: "application/json" }
});

    // The "System Prompt" - This forces the AI to behave like a strict API parser
    const promptInstruction = `
      You are a trading execution agent. Convert the user's natural language trading command into a strict JSON object.
      User Command: "${prompt}"
      
      You must return ONLY a raw JSON object with no markdown formatting, no backticks, and no extra text.
      
      Required JSON Schema:
      {
        "side": "BUY" or "SELL",
        "symbol": "BTCUSDT", "ETHUSDT", "SOLUSDT", or "BNBUSDT" (Infer the crypto from the text. Always append USDT),
        "orderType": "MARKET" or "LIMIT",
        "limitPrice": Number or null (If they mention a target price, it is a LIMIT order. Extract the price.),
        "quantity": Number (The exact amount of crypto they want to trade. If they specify dollars (e.g., "$50 of BTC"), you MUST calculate the crypto quantity using the current estimated market price. Assume BTC=65000, ETH=3500, SOL=150, BNB=600 for math if needed, but return the final crypto amount).
      }
      
      Example Input: "Buy 0.5 Bitcoin if it drops to 60k"
      Example Output: {"side": "BUY", "symbol": "BTCUSDT", "orderType": "LIMIT", "limitPrice": 60000, "quantity": 0.5}
    `;

    // Send to Gemini
    const result = await model.generateContent(promptInstruction);
    let rawText = result.response.text();
    
    // Clean up any potential markdown formatting the AI tries to sneak in
    rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    const parsedData = JSON.parse(rawText);

    res.json({
      success: true,
      message: "Agent successfully parsed intent",
      data: parsedData
    });

  } catch (err) {
    console.error("🔥 AI COPILOT ERROR:", err);
    res.status(500).json({ success: false, message: "Agent failed to understand command." });
  }
});

module.exports = router;