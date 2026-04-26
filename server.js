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

let cache = {};
const CACHE_TTL = 3 * 60 * 1000;

app.use(express.static(join(__dirname, 'public')));

// Diary entries
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
    console.error('Entries error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: err.message });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  try {
    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { query: q, max_results: 20, max_tokens: 10000 }
    });
    res.json(parseEntries(result));
  } catch (err) {
    console.error('Search error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: err.message });
  }
});

// All memories via breath
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
    console.error('All error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: err.message });
  }
});

// Full list via pulse
app.get('/api/pulse', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.pulse && now - cache.pulseTime < CACHE_TTL) {
      return res.json(cache.pulse);
    }
    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'pulse',
      arguments: { include_archive: false }
    });
    const text = result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    console.log('Pulse raw output length:', text.length);

    const buckets = [];
    const lines = text.split('\n');
    for (const line of lines) {
      // Match bucket_id first
      const idMatch = line.match(/bucket_id:(\w{12})/);
      if (!idMatch) continue;

      const id = idMatch[1];
      const isPinned = line.includes('\u{1F4CC}'); // 📌
      const isFeel = line.includes('\u{1FAE7}');   // 🫧
      // isDynamic = 💭 or anything else

      // Extract name: [name] or 记忆桶: name
      let title = id;
      const nameMatch1 = line.match(/\[([^\]]+)\]\s*bucket_id/);
      if (nameMatch1) {
        title = nameMatch1[1].replace(/记忆桶:\s*/, '').trim();
      }

      // Extract emotion
      let valence = 0.5, arousal = 0.3;
      const emoMatch = line.match(/V([\d.]+)\/A([\d.]+)/);
      if (emoMatch) {
        valence = parseFloat(emoMatch[1]);
        arousal = parseFloat(emoMatch[2]);
      }

      // Extract tags
      let tags = [];
      const tagsMatch = line.match(/标签:(.+)/);
      if (tagsMatch) {
        tags = tagsMatch[1].split(',').map(t => t.trim()).filter(t => t);
      }

      buckets.push({ id, title, pinned: isPinned, feel: isFeel, valence, arousal, tags });
    }

    console.log('Parsed buckets:', buckets.length);
    cache.pulse = buckets;
    cache.pulseTime = now;
    res.json(buckets);
  } catch (err) {
    console.error('Pulse error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: err.message });
  }
});

// Single bucket detail
app.get('/api/bucket/:id', async (req, res) => {
  try {
    await ensureConnected();
    const result = await mcpClient.callTool({
      name: 'breath',
      arguments: { query: req.params.id, max_results: 5, max_tokens: 5000 }
    });
    const entries = parseEntries(result);
    const match = entries.find(e => e.id === req.params.id);
    res.json(match || entries[0] || { content: 'No content found' });
  } catch (err) {
    console.error('Bucket error:', err.message);
    mcpClient = null;
    res.status(500).json({ error: err.message });
  }
});

// Parse breath response
function parseEntries(result) {
  const entries = [];
  if (!result || !result.content) return entries;

  const text = result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  const buckets = text.split(/---\n?/);

  for (const bucket of buckets) {
    if (!bucket.trim()) continue;
    const entry = {};

    const idMatch = bucket.match(/\[bucket_id:(\w+)\]/);
    if (idMatch) entry.id = idMatch[1];

    const nameMatch = bucket.match(/记忆桶:\s*(.+?)\s*\[/);
    if (nameMatch) entry.title = nameMatch[1];

    const emotionMatch = bucket.match(/V([\d.]+)\/A([\d.]+)/);
    if (emotionMatch) {
      entry.valence = parseFloat(emotionMatch[1]);
      entry.arousal = parseFloat(emotionMatch[2]);
    }

    const tagsMatch = bucket.match(/标签:(.+)/);
    if (tagsMatch) {
      entry.tags = tagsMatch[1].split(',').map(t => t.trim());
    }

    // Date ONLY from tags (not from content)
    if (entry.tags) {
      for (const tag of entry.tags) {
        const tagDate = tag.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (tagDate) {
          entry.date = tag;
          break;
        }
      }
    }

    const contentLines = bucket.split('\n').slice(1);
    const contentText = contentLines.join('\n').trim();

    try {
      const jsonMatch = contentText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        entry.summary = parsed.summary || '';
        entry.content = parsed.core_facts ? parsed.core_facts.join('\n') : contentText;
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

app.listen(PORT, () => {
  console.log('Nemo Diary running on port ' + PORT);
  connectMCP().catch(err => console.error('Initial MCP failed:', err.message));
});
