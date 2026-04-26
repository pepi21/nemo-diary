import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const OMBRE_URL = process.env.OMBRE_URL || 'https://ombre-brain-71kg.onrender.com/mcp';

// --- MCP Client ---
let mcpClient = null;
let isConnecting = false;

async function connectMCP() {
  if (mcpClient || isConnecting) return;
  isConnecting = true;
  try {
    const client = new Client(
      { name: 'nemo-diary', version: '1.0.0' },
      { capabilities: {} }
    );

    // Try Streamable HTTP first, fallback to SSE
    let transport;
    try {
      transport = new StreamableHTTPClientTransport(new URL(OMBRE_URL));
      await client.connect(transport);
    } catch (e) {
      console.log('Streamable HTTP failed, trying SSE...');
      const sseUrl = new URL(OMBRE_URL.replace(/\/mcp$/, '/sse'));
      transport = new SSEClientTransport(sseUrl);
      await client.connect(transport);
    }

    mcpClient = client;
    console.log('Connected to ombrebrain');
  } catch (err) {
    console.error('MCP connection failed:', err.message);
    mcpClient = null;
  } finally {
    isConnecting = false;
  }
}

async function ensureConnected() {
  if (!mcpClient) await connectMCP();
  if (!mcpClient) throw new Error('Cannot connect to ombrebrain');
}

// --- Cache ---
let cache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

// --- API Routes ---
app.use(express.static(join(__dirname, 'public')));

// Get diary entries
app.get('/api/entries', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.entries && now - cache.entriesTime < CACHE_TTL) {
      return res.json(cache.entries);
    }

    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { query: '日記 diary', max_results: 50, max_tokens: 15000 }
    });

    const entries = parseEntries(result);
    cache.entries = entries;
    cache.entriesTime = now;
    res.json(entries);
  } catch (err) {
    console.error('Error fetching entries:', err.message);
    // If MCP fails, try reconnecting next time
    mcpClient = null;
    res.status(500).json({ error: 'Unable to fetch diary entries', message: err.message });
  }
});

// Search memories
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  try {
    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { query: q, max_results: 20, max_tokens: 10000 }
    });

    const entries = parseEntries(result);
    res.json(entries);
  } catch (err) {
    console.error('Search error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Get all memories (for timeline view)
app.get('/api/all', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.all && now - cache.allTime < CACHE_TTL) {
      return res.json(cache.all);
    }

    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { max_results: 50, max_tokens: 15000 }
    });

    const entries = parseEntries(result);
    cache.all = entries;
    cache.allTime = now;
    res.json(entries);
  } catch (err) {
    console.error('Error fetching all:', err.message);
    mcpClient = null;
    res.status(500).json({ error: 'Unable to fetch memories', message: err.message });
  }
});

// Get complete memory list via pulse
app.get('/api/pulse', async (req, res) => {
  try {
    const now = Date.now();
    const includeArchive = req.query.archive === 'true';
    const cacheKey = includeArchive ? 'pulseAll' : 'pulse';

    if (cache[cacheKey] && now - cache[cacheKey + 'Time'] < CACHE_TTL) {
      return res.json(cache[cacheKey]);
    }

    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'pulse',
      arguments: { include_archive: includeArchive }
    });

    const text = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    // Parse pulse output into bucket list
    const buckets = [];
    const lines = text.split('\n');
    for (const line of lines) {
      // Match pinned buckets: 📌 记忆桶: name [bucket_id:xxx]
      // Match dynamic buckets: 🫧 记忆桶: name [bucket_id:xxx]
      const match = line.match(/([📌🫧])\s*记忆桶:\s*(.+?)\s*\[bucket_id:(\w+)\]/);
      if (match) {
        const bucket = {
          pinned: match[1] === '📌',
          title: match[2],
          id: match[3]
        };
        // Extract emotion
        const emo = line.match(/V([\d.]+)\/A([\d.]+)/);
        if (emo) {
          bucket.valence = parseFloat(emo[1]);
          bucket.arousal = parseFloat(emo[2]);
        }
        // Extract tags
        const tags = line.match(/标签:([^\]]+)/);
        if (tags) {
          bucket.tags = tags[1].split(',').map(t => t.trim());
        }
        // Extract date
        const dateMatch = line.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (dateMatch) {
          bucket.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
        }
        buckets.push(bucket);
      }
    }

    cache[cacheKey] = buckets;
    cache[cacheKey + 'Time'] = now;
    res.json(buckets);
  } catch (err) {
    console.error('Pulse error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: 'Unable to fetch pulse', message: err.message });
  }
});

// Get single bucket detail
app.get('/api/bucket/:id', async (req, res) => {
  try {
    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { query: req.params.id, max_results: 5, max_tokens: 5000 }
    });

    const entries = parseEntries(result);
    const match = entries.find(e => e.id === req.params.id);
    if (match) {
      res.json(match);
    } else if (entries.length > 0) {
      res.json(entries[0]);
    } else {
      res.status(404).json({ error: 'Bucket not found' });
    }
  } catch (err) {
    console.error('Bucket fetch error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: 'Failed to fetch bucket', message: err.message });
  }
});

// --- Parse ombrebrain response ---
function parseEntries(result) {
  const entries = [];
  if (!result || !result.content) return entries;

  // result.content is an array of content blocks
  const text = result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  // Split by bucket separator
  const buckets = text.split(/---\n?/);

  for (const bucket of buckets) {
    if (!bucket.trim()) continue;

    const entry = {};

    // Extract bucket ID
    const idMatch = bucket.match(/\[bucket_id:(\w+)\]/);
    if (idMatch) entry.id = idMatch[1];

    // Extract name
    const nameMatch = bucket.match(/记忆桶:\s*(.+?)\s*\[/);
    if (nameMatch) entry.title = nameMatch[1];

    // Extract emotion
    const emotionMatch = bucket.match(/V([\d.]+)\/A([\d.]+)/);
    if (emotionMatch) {
      entry.valence = parseFloat(emotionMatch[1]);
      entry.arousal = parseFloat(emotionMatch[2]);
    }

    // Extract tags
    const tagsMatch = bucket.match(/标签:(.+)/);
    if (tagsMatch) {
      entry.tags = tagsMatch[1].split(',').map(t => t.trim());
    }

    // Extract date from tags or content
    const dateMatch = bucket.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (dateMatch) {
      entry.date = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }

    // Check if this is a diary entry
    if (entry.tags) {
      entry.isDiary = entry.tags.some(t =>
        t.includes('日記') || t.includes('diary') || t.includes('日记')
      );
    }

    // Extract content (everything after the header line)
    const contentLines = bucket.split('\n').slice(1);
    const contentText = contentLines.join('\n').trim();

    // Try to parse JSON content
    try {
      const jsonMatch = contentText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        entry.summary = parsed.summary || '';
        entry.content = parsed.core_facts ? parsed.core_facts.join('\n') : contentText;
        entry.emotion_state = parsed.emotion_state || '';
      } else {
        entry.content = contentText;
      }
    } catch {
      entry.content = contentText;
    }

    if (entry.id) entries.push(entry);
  }

  return entries;
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`Nemo Diary running on port ${PORT}`);
  // Connect to ombrebrain in background
  connectMCP().catch(err => console.error('Initial MCP connection failed:', err.message));
});
