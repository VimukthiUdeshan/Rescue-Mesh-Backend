const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function summarizeMessage(message, attempt = 1) {
  try {
    // Using the 2.5 Flash model from provided list
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
      You are an emergency response coordinator. 
      Summarize the following flood rescue request into 1-2 concise lines.
      If the message is in Sinhala, provide the summary in Sinhala.
      
      Message: ${message}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (err) {
    // 429 Handle: Backoff and Retry
    if (err.status === 429 && attempt <= 3) {
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return summarizeMessage(message, attempt + 1);
    }

    console.error("Gemini SDK Error:", err.message);
    throw err; 
  }
}

module.exports = summarizeMessage;