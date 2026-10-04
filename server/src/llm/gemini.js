// Minimal Gemini REST client (no SDK dependency). Returns parsed JSON plus usage metadata.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

async function generateJson({ system, user, model, apiKey, timeoutMs = 30000, retries = 3 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            // 2.5 Flash "thinks" by default; these are short structured tasks, so skip it for latency.
            ...(/2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`Gemini HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 2));
        continue;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${body.error ? body.error.message : 'error'}`);
      const text = body.candidates && body.candidates[0] && body.candidates[0].content
        ? body.candidates[0].content.parts.map(p => p.text || '').join('') : '';
      if (!text) throw new Error(`Gemini returned no content (finishReason=${body.candidates && body.candidates[0] ? body.candidates[0].finishReason : 'n/a'})`);
      const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
      const u = body.usageMetadata || {};
      return { json, usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 } };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('Gemini request timed out') : e;
      if (!/HTTP (429|5\d\d)|timed out/.test(lastErr.message)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { generateJson };
