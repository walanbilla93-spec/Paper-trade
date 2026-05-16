'use strict';

// ── Orayan AI Proxy — fix24b ─────────────────────────────────────────────────
// Browser calls POST /api/ai/analyze with { provider, prompt } in body.
// Backend calls the AI provider using server-stored API keys.
// No CORS issues, no referer restrictions, keys never exposed to browser.
//
// API keys read from Northflank env vars:
//   GEMINI_API_KEY
//   OPENROUTER_API_KEY
//   GROQ_API_KEY
//   OPENAI_API_KEY
//
// Falls back to keys stored in settings (bot.js saves them via /bot/settings).

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const auth    = require('../middleware/auth');
const { getSettings } = require('../lib/config');

// ── Model preference lists (ordered, first available wins) ──────────────────
const AI_MODELS = {
  gemini:     ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
  openrouter: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-12b-it:free', 'mistralai/mistral-7b-instruct:free'],
  groq:       ['llama-3.3-70b-versatile', 'llama3-70b-8192', 'mixtral-8x7b-32768'],
  openai:     ['gpt-4o-mini', 'gpt-3.5-turbo'],
};

// ── Resolve API key: env var > settings store ────────────────────────────────
function resolveKey(provider) {
  const ENV_KEYS = {
    gemini:     process.env.GEMINI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    groq:       process.env.GROQ_API_KEY,
    openai:     process.env.OPENAI_API_KEY,
  };
  if (ENV_KEYS[provider]) return ENV_KEYS[provider];
  // Fall back to settings (user may have saved keys via UI)
  const s = getSettings();
  if (provider === 'gemini')     return s.geminiApiKey || s.aiApiKey || '';
  if (provider === 'openrouter') return s.openrouterApiKey || '';
  if (provider === 'groq')       return s.groqApiKey || s.aiApiKey || '';
  if (provider === 'openai')     return s.openaiApiKey || s.aiApiKey || '';
  return '';
}

// ── Call a single provider with model fallback ───────────────────────────────
async function callProvider(provider, systemPrompt, userPrompt) {
  const apiKey = resolveKey(provider);
  if (!apiKey) throw new Error(`NO_KEY:${provider}`);

  const models = AI_MODELS[provider] || [];
  let lastErr = '';

  for (const model of models) {
    try {
      if (provider === 'gemini') {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const resp = await axios.post(url, {
          contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' },
        }, { timeout: 25000 });
        const raw = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        return {
          raw, model,
          inputT:  resp.data?.usageMetadata?.promptTokenCount || 0,
          outputT: resp.data?.usageMetadata?.candidatesTokenCount || 0,
        };

      } else {
        // OpenAI-compatible endpoint (openrouter / groq / openai)
        const ENDPOINTS = {
          openrouter: 'https://openrouter.ai/api/v1/chat/completions',
          groq:       'https://api.groq.com/openai/v1/chat/completions',
          openai:     'https://api.openai.com/v1/chat/completions',
        };
        const headers = {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        };
        if (provider === 'openrouter') {
          headers['HTTP-Referer'] = 'https://p01--bybit-back--rpfg4d97xnm6.code.run';
          headers['X-Title']      = 'Orayan';
        }
        const resp = await axios.post(ENDPOINTS[provider], {
          model,
          max_tokens: 300,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt   },
          ],
        }, { headers, timeout: 25000 });
        const raw = resp.data?.choices?.[0]?.message?.content || '{}';
        return {
          raw, model,
          inputT:  resp.data?.usage?.prompt_tokens || 0,
          outputT: resp.data?.usage?.completion_tokens || 0,
        };
      }

    } catch (e) {
      const status = e?.response?.status;
      const msg    = e?.response?.data?.error?.message || e.message || '';

      if (status === 401 || /api.key|invalid.key|unauthorized/i.test(msg)) throw new Error(`INVALID_KEY:${provider}`);
      if (status === 429 || /rate.limit|quota/i.test(msg))                  throw new Error(`RATE_LIMIT:${provider}`);
      if (status === 403 && /allowlist/i.test(msg))                         throw new Error(`DOMAIN_NOT_ALLOWED:${provider}`);

      // Model unavailable → try next model
      lastErr = `${model}: ${msg || status}`;
    }
  }
  throw new Error(`ALL_MODELS_FAILED:${provider} — ${lastErr}`);
}

// ── Fallback chain ───────────────────────────────────────────────────────────
const CHAIN_ORDER = ['gemini', 'openrouter', 'groq', 'openai'];

function buildChain(primary) {
  return [primary, ...CHAIN_ORDER.filter(p => p !== primary)];
}

// ── POST /api/ai/analyze ─────────────────────────────────────────────────────
// Body: { provider, systemPrompt, userPrompt }
// Returns: { ok, raw, model, provider, inputT, outputT }
router.post('/analyze', auth, async (req, res) => {
  const { provider: reqProvider, systemPrompt, userPrompt } = req.body || {};

  if (!systemPrompt || !userPrompt) {
    return res.status(400).json({ ok: false, error: 'Missing systemPrompt or userPrompt' });
  }

  const primary = reqProvider || 'gemini';
  const chain   = buildChain(primary);
  let lastErr   = '';
  let usedProvider = '';

  for (const p of chain) {
    const key = resolveKey(p);
    if (!key) continue; // no key → skip silently

    try {
      const result = await callProvider(p, systemPrompt, userPrompt);
      usedProvider = p;
      return res.json({
        ok: true,
        raw:       result.raw,
        model:     result.model,
        provider:  p,
        inputT:    result.inputT,
        outputT:   result.outputT,
        fallback:  p !== primary,
      });
    } catch (e) {
      lastErr = e.message || String(e);
      // INVALID_KEY → stop chain immediately
      if (lastErr.startsWith('INVALID_KEY')) break;
      // RATE_LIMIT / model failures → try next provider
    }
  }

  return res.status(502).json({
    ok:    false,
    error: lastErr || 'All providers failed',
    chain,
  });
});

// ── GET /api/ai/status ───────────────────────────────────────────────────────
// Returns which providers have keys configured (without revealing key values).
router.get('/status', auth, (req, res) => {
  const providers = CHAIN_ORDER.map(p => ({
    provider: p,
    hasKey: !!resolveKey(p),
    models: AI_MODELS[p],
  }));
  res.json({ ok: true, providers });
});

module.exports = router;
