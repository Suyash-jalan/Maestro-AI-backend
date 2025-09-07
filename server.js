// server.js (ES module syntax)
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import * as cheerio from 'cheerio'; // Added for content extraction
import { Readability } from "@mozilla/readability"; // Added for better article parsing
import { JSDOM } from "jsdom"; // For DOM parsing with Readability

dotenv.config();
const app = express();
const upload = multer(); // in-memory storage

app.use(cors());
app.use(express.json());

/* ---------- helper: clean bullets ---------- */
const cleanBullets = (text, max = 8) =>
  text
    .split("\n")
    .map((l) => l.replace(/^[*\-#\s]+/, "").replace(/[*#`]/g, "").trim())
    .filter((l) => l.length > 3)
    .slice(0, max)
    .map((l) => `- ${l}`)
    .join("\n");

/* ---------- helper: build 5-bullet CONCLUSION with citations ---------- */
const buildConclusion = (results, sources) => {
  const lines = [];
  const citationsMap = {}; // Track citations per line
  for (const [model, text] of Object.entries(results)) {
    const bullets = text
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter((l) => l.length > 3);
    bullets.forEach((b, i) => {
      lines.push(b);
      // Associate with source (simplified: link model to sources)
      if (sources[model] && sources[model][i]) {
        citationsMap[b] = sources[model][i];
      }
    });
  }
  const unique = [...new Set(lines)].slice(0, 5);
  return unique.map((b) => {
    const cit = citationsMap[b] ? ` [${citationsMap[b].title}](${citationsMap[b].url}) (${citationsMap[b].date || 'N/A'})` : '';
    return `- ${b}${cit}`;
  }).join("\n");
};

/* ---------- safe API call ---------- */
const safeCall = async (fn, fallback, name, maxBullets = 8) => {
  try {
    const raw = await fn();
    return cleanBullets(raw, maxBullets);
  } catch (err) {
    console.error(`❌ ${name} API error:`, err.response?.data || err.message);
    return typeof fallback === "function" ? fallback(err) : fallback;
  }
};

/* ---------- bullet prompt with context ---------- */
const bulletPrompt = (q, context = '', count = 8, analysis = false) => {
  let prompt = `Answer in ${count} short bullet points (max one line each). Include key facts, trends, and cite sources if provided.\n`;
  if (analysis) {
    prompt += `Also identify pros/cons, differing viewpoints, or gaps if applicable.\n`;
  }
  if (context) {
    prompt += `Context from sources: ${context}\n\n`;
  }
  prompt += `Q: ${q}\nA:`;
  return prompt;
};

/* ---------- web search and extraction helper ---------- */
const performWebSearch = async (query) => {
  try {
    const searchUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${process.env.SERPAPI_KEY}&num=10`;
    const { data } = await axios.get(searchUrl);
    const results = data.organic_results || [];
    const extracted = await Promise.all(results.slice(0, 5).map(async (res) => { // Top 5
      try {
        const page = await axios.get(res.link);
        const dom = new JSDOM(page.data);
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        return {
          url: res.link,
          title: article?.title || res.title,
          date: res.date || article?.publishedTime || 'N/A',
          excerpt: article?.excerpt || article?.textContent?.substring(0, 1000) || 'No content',
        };
      } catch (e) {
        console.error(`Failed to extract ${res.link}: ${e.message}`);
        return null;
      }
    }));
    return extracted.filter(Boolean);
  } catch (err) {
    console.error('Search error:', err);
    return [];
  }
};

/* ---------- SINGLE ENDPOINT ---------- */
app.post("/ask", upload.single("file"), async (req, res) => {
  const question = req.body.question?.trim?.() || "";

  let sources = {}; // Model -> array of sources per bullet (simplified)

  /* ----------- FILE FLOW (Gemini only, with optional search) ----------- */
  if (req.file) {
    // Optional: Search related to file description
    const fileQuery = question || "Describe the uploaded file.";
    const webSources = await performWebSearch(fileQuery);
    const context = webSources.map(s => `Source: ${s.title} (${s.url}, ${s.date}): ${s.excerpt.substring(0, 500)}`).join('\n');

    const gemini = await safeCall(
      async () => {
        const parts = [
          { text: bulletPrompt(fileQuery, context, 8, true) },
          {
            inlineData: {
              data: req.file.buffer.toString("base64"),
              mimeType: req.file.mimetype,
            },
          },
        ];
        const model = "gemini-1.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const { data } = await axios.post(
          url,
          { contents: [{ parts }] },
          { headers: { "Content-Type": "application/json" } }
        );
        sources.gemini = webSources; // Associate sources
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini";
      },
      "Error from Gemini",
      "Gemini",
      8
    );

    return res.json({
      results: { gemini },
      conclusion: buildConclusion({ gemini }, sources),
      sources: webSources, // Global sources for UI
    });
  }

  /* ----------- TEXT FLOW (4 models with search) ----------- */
  if (!question) return res.status(400).json({ error: "Question cannot be empty" });

  // Perform web search and extraction
  const webSources = await performWebSearch(question);
  const context = webSources.map(s => `Source: ${s.title} (${s.url}, ${s.date}): ${s.excerpt.substring(0, 500)}`).join('\n');

  const [openai, mistral, claude] = await Promise.all([
    // 1️⃣ OpenAI with context
    safeCall(
      async () => {
        const r = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: bulletPrompt(question, context, 8, true) }],
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        sources.openai = webSources;
        return r.data.choices[0].message.content;
      },
      "Error from OpenAI",
      "OpenAI",
      8
    ),

    // 2️⃣ Mistral with context
    safeCall(
      async () => {
        const r = await axios.post(
          "https://api.mistral.ai/v1/chat/completions",
          {
            model: "mistral-small",
            messages: [{ role: "user", content: bulletPrompt(question, context, 8, true) }],
          },
          { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}` } }
        );
        sources.mistral = webSources;
        return r.data.choices[0].message.content;
      },
      "Error from Mistral",
      "Mistral",
      8
    ),

    // 3️⃣ Claude with context
    safeCall(
      async () => {
        const { data } = await axios.post(
          "https://api.anthropic.com/v1/messages",
          {
            model: "claude-3-sonnet-20240229",
            max_tokens: 800,
            messages: [{ role: "user", content: bulletPrompt(question, context, 8, true) }],
          },
          {
            headers: {
              "x-api-key": process.env.CLAUDE_API_KEY,
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
            },
          }
        );
        sources.claude = webSources;
        return data.content[0].text;
      },
      "Error from Claude",
      "Claude",
      8
    ),
  ]);

  // 4️⃣ Gemini (text mode) with context
  const gemini = await safeCall(
    async () => {
      const { data } = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: bulletPrompt(question, context, 8, true) }] }] },
        { headers: { "Content-Type": "application/json" } }
      );
      sources.gemini = webSources;
      return data.candidates[0].content.parts[0].text;
    },
    "Error from Gemini",
    "Gemini",
    8
  );

  const results = { openai, mistral, claude, gemini };
  const conclusion = buildConclusion(results, sources);

  res.json({ results, conclusion, sources: webSources });
});

/* ---------- START SERVER ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));