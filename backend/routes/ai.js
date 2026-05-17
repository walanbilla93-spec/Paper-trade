'use strict';

// ── Orayan AI Proxy — fix24d ─────────────────────────────────────────────────
// Browser calls POST /api/ai/analyze with { provider, systemPrompt, userPrompt } in body.
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
  openrouter: ['meta-llama/llama-3.3-8b-instruct:free', 'mistralai/mistral-small-3.1-24b-instruct:free', 'google/gemma-3-4b-it:free'],
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
async function postJson(url, body, opts) {
  return axios.post(url, body, opts);
}

async function callProvider(provider, systemPrompt, userPrompt) {
  const apiKey = resolveKey(provider);
  if (!apiKey) throw new Error(`NO_KEY:${provider}`);

  const models = AI_MODELS[provider] || [];
  const errors = [];
  let sawRateLimit = false;

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
      }

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
        headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'https://p01--bybit-back--rpfg4d97xnm6.code.run';
        headers['X-Title']      = 'Orayan';
      }

      const baseBody = {
        model,
        max_tokens: 300,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      };

      let resp;
      try {
        resp = await postJson(ENDPOINTS[provider], {
          ...baseBody,
          response_format: { type: 'json_object' },
        }, { headers, timeout: 25000 });
      } catch (e) {
        const status = e?.response?.status;
        const msg = e?.response?.data?.error?.message || e?.message || '';
        // Some free/router models reject JSON response_format. Retry once without it.
        if (status === 400 && /response_format|json/i.test(msg)) {
          resp = await postJson(ENDPOINTS[provider], baseBody, { headers, timeout: 25000 });
        } else {
          throw e;
        }
      }

      const raw = resp.data?.choices?.[0]?.message?.content || '{}';
      return {
        raw, model,
        inputT:  resp.data?.usage?.prompt_tokens || 0,
        outputT: resp.data?.usage?.completion_tokens || 0,
      };

    } catch (e) {
      const status = e?.response?.status;
      const msg    = e?.response?.data?.error?.message || e?.response?.data?.error || e.message || '';
      const compact = String(msg).replace(/\s+/g, ' ').slice(0, 180);

      if (status === 401 || /api.key|invalid.key|unauthorized/i.test(compact)) {
        throw new Error(`INVALID_KEY:${provider}:${model}:${compact}`);
      }
      if (status === 403 && /allowlist|referer|origin/i.test(compact)) {
        throw new Error(`DOMAIN_NOT_ALLOWED:${provider}:${model}:${compact}`);
      }
      if (status === 429 || /rate.limit|quota|too many requests|resource exhausted/i.test(compact)) {
        sawRateLimit = true;
        errors.push(`${model}: RATE_LIMIT ${compact}`);
        continue; // try the next model for the same provider before giving up
      }

      errors.push(`${model}: ${status || 'ERR'} ${compact}`);
      // model unavailable/transient errors: try next model/provider
    }
  }

  if (sawRateLimit && errors.length === models.length) {
    throw new Error(`RATE_LIMIT:${provider}:${errors.join(' | ')}`);
  }
  throw new Error(`ALL_MODELS_FAILED:${provider}:${errors.join(' | ') || 'unknown error'}`);
}

// ── Fallback chain ───────────────────────────────────────────────────────────
const CHAIN_ORDER = ['gemini', 'openrouter', 'groq', 'openai'];

function buildChain(primary) {
  return [primary, ...CHAIN_ORDER.filter(p => p !== primary)];
}


// Explicit preflight endpoint for hosts/proxies that do not forward OPTIONS cleanly.
router.options('/analyze', (req, res) => res.sendStatus(204));
router.options('/status',  (req, res) => res.sendStatus(204));

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
  const attempts = [];
  let keyedProviders = 0;
  let rateLimitedProviders = 0;

  for (const p of chain) {
    const key = resolveKey(p);
    if (!key) {
      attempts.push({ provider: p, status: 'NO_KEY' });
      continue;
    }
    keyedProviders += 1;

    try {
      const result = await callProvider(p, systemPrompt, userPrompt);
      return res.json({
        ok: true,
        raw:       result.raw,
        model:     result.model,
        provider:  p,
        inputT:    result.inputT,
        outputT:   result.outputT,
        fallback:  p !== primary,
        attempts,
      });
    } catch (e) {
      lastErr = e.message || String(e);
      const status = lastErr.split(':')[0] || 'ERROR';
      if (status === 'RATE_LIMIT') rateLimitedProviders += 1;
      attempts.push({ provider: p, status, error: lastErr.slice(0, 500) });
      // Do not stop the chain for one provider's quota. Try every configured provider.
      // Only invalid keys/domain issues for that provider are recorded, not fatal to others.
    }
  }

  const noKeys = keyedProviders === 0;
  const allKeyedRateLimited = keyedProviders > 0 && rateLimitedProviders === keyedProviders;
  return res.status(allKeyedRateLimited ? 429 : 502).json({
    ok: false,
    error: noKeys ? 'NO_BACKEND_AI_KEY' : (allKeyedRateLimited ? 'ALL_BACKEND_AI_PROVIDERS_RATE_LIMITED' : (lastErr || 'All providers failed')),
    chain,
    attempts,
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
