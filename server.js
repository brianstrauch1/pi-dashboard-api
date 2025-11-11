// server.js
console.log('Booting server.js...');
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Env
const { JIRA_BASE_URL, JIRA_TOKEN, PORT } = process.env;
if (!JIRA_BASE_URL || !JIRA_TOKEN) {
  console.error('❌ Missing JIRA_BASE_URL or JIRA_TOKEN in .env / environment');
  process.exit(1);
}

// Jira client
const jira = axios.create({
  baseURL: JIRA_BASE_URL.replace(/\/$/, ''),
  headers: { Authorization: `Bearer ${JIRA_TOKEN}` },
  timeout: 30000
});

// ---------------- Notes / Blockers storage ----------------
const NOTES_FILE = path.join(__dirname, 'notes.json');

// Ensure file exists
function ensureNotesFile() {
  try {
    if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, JSON.stringify({}, null, 2));
  } catch (e) {
    console.error('Failed to ensure notes file:', e);
  }
}

function loadAllBuckets() {
  ensureNotesFile();
  try {
    const raw = fs.readFileSync(NOTES_FILE, 'utf8') || '{}';
    const data = JSON.parse(raw);
    return data;
  } catch (e) {
    console.error('Failed to parse notes file:', e);
    return {};
  }
}

function saveAllBuckets(obj) {
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save notes file:', e);
  }
}

const sprintKey = (projectKey, sprintName) => `${projectKey}|||${sprintName}`;

// Migrate legacy { [issueKey]: "note" } bucket to { notes:{}, blockers:{} }
function normalizeBucket(bucketLike) {
  // New format { notes:{}, blockers:{} }
  if (bucketLike && typeof bucketLike === 'object' && (bucketLike.notes || bucketLike.blockers)) {
    if (!bucketLike.notes) bucketLike.notes = {};
    if (!bucketLike.blockers) bucketLike.blockers = {};
    return bucketLike;
  }
  // Old format: plain map of issueKey->note
  if (bucketLike && typeof bucketLike === 'object') {
    return { notes: bucketLike, blockers: {} };
  }
  return { notes: {}, blockers: {} };
}

// ---------------- Request log ----------------
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ---------------- Root & health ----------------
app.head('/', (_req, res) => res.sendStatus(200));
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h1>PI Dashboard API</h1>
    <p>API is running ✅</p>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/projects">/api/projects</a></li>
    </ul>
  `);
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------- Me / Fields / Projects ----------------
app.get('/api/me', async (_req, res) => {
  try {
    const { data } = await jira.get('/rest/api/2/myself');
    res.json({ ok: true, displayName: data.displayName, name: data.name || data.accountId });
  } catch (e) {
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

app.get('/api/fields', async (_req, res) => {
  try {
    const { data } = await jira.get('/rest/api/2/field');
    res.json(data.map(f => ({ id: f.id, name: f.name, schema: f.schema })));
  } catch (e) {
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

app.get('/api/projects', async (_req, res) => {
  try {
    const { data } = await jira.get('/rest/api/2/project');
    const projects = (Array.isArray(data) ? data : []).map(p => ({
      id: p.id, key: p.key, name: p.name
    })).sort((a,b)=>a.name.localeCompare(b.name));
    res.json({ projects });
  } catch (e) {
    console.error('projects error', e.response?.status, e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

// ---------------- Sprints (with state-ordered output) ----------------
app.get('/api/sprints', async (req, res) => {
  try {
    const { projectKeyOrId } = req.query;
    if (!projectKeyOrId) return res.status(400).json({ error: 'Missing projectKeyOrId' });

    async function agilePaged(path, params = {}, hardLimit = 5000) {
      let startAt = 0, out = [];
      while (true) {
        const { data } = await jira.get(path, { params: { ...params, startAt, maxResults: 50 } });
        const values = data.values || data.issues || data.sprints || [];
        out = out.concat(values);
        const total = data.total ?? out.length;
        if (data.isLast || startAt + values.length >= total || !values.length || out.length >= hardLimit) break;
        startAt += values.length;
      }
      return out;
    }

    let boards = [];
    try {
      boards = await agilePaged('/rest/agile/1.0/board', { projectKeyOrId, type: 'scrum' });
    } catch {
      const allBoards = await agilePaged('/rest/agile/1.0/board', { projectKeyOrId });
      boards = allBoards.filter(b => (b.type || '').toLowerCase() === 'scrum');
    }

    const seen = new Map();
    for (const b of boards) {
      try {
        const sprints = await agilePaged(`/rest/agile/1.0/board/${b.id}/sprint`, { state: 'active,future,closed' });
        for (const s of sprints) {
          if (!seen.has(s.id)) {
            seen.set(s.id, { id: s.id, name: s.name, state: s.state, boardId: b.id, boardName: b.name });
          }
        }
      } catch (err) {
        const msg = err.response?.data?.errorMessages?.[0] || err.message || '';
        if (/doesn'?t support sprints/i.test(msg)) {
          console.log(`ℹ️  Board ${b.id} (${b.name}) skipped: ${msg}`);
          continue;
        }
        console.warn(`⚠️  Failed to read sprints for board ${b.id}:`, msg);
      }
    }

    let list = Array.from(seen.values());

    // Fallback: derive sprint names from issues
    if (!list.length) {
      console.log('ℹ️  No Scrum sprints found; fallback to issue scan…');
      const fields = ['customfield_10020'];
      let startAt = 0;
      const maxResults = 100;
      const names = new Set();

      while (true) {
        const { data } = await jira.post('/rest/api/2/search', {
          jql: `project = ${projectKeyOrId}`,
          fields,
          startAt,
          maxResults
        });
        const issues = data.issues || [];
        for (const iss of issues) {
          const sf = iss.fields?.customfield_10020;
          if (!sf) continue;
          const arr = Array.isArray(sf) ? sf : [sf];
          for (const v of arr) {
            if (typeof v === 'string') {
              const m = /name=([^,]+)/.exec(v);
              if (m?.[1]) names.add(m[1]);
            } else if (v && typeof v === 'object' && v.name) {
              names.add(v.name);
            }
          }
        }
        startAt += issues.length;
        if (startAt >= (data.total || 0) || !issues.length) break;
      }

      list = Array.from(names).sort().map(n => ({ id: `derived:${n}`, name: n, state: 'unknown', boardId: null, boardName: 'derived-from-issues' }));
    }

    // Order by Active → Future → Closed → Unknown, then name
    const order = { active: 0, future: 1, closed: 2, unknown: 3 };
    list.sort((a,b) => {
      const sa = order[(a.state || '').toLowerCase()] ?? 9;
      const sb = order[(b.state || '').toLowerCase()] ?? 9;
      if (sa !== sb) return sa - sb;
      return (a.name || '').localeCompare(b.name || '');
    });

    res.json({ sprints: list });
  } catch (e) {
    console.error('sprints error', e.response?.status, e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

// ---------------- Notes & Blockers API ----------------
app.get('/api/notes', (req, res) => {
  const { project, sprint } = req.query;
  if (!project || !sprint) return res.status(400).json({ error: 'Missing project or sprint' });
  const all = loadAllBuckets();
  const bucket = normalizeBucket(all[sprintKey(project, sprint)]);
  res.json({ notes: bucket.notes, blockers: bucket.blockers });
});

// Update task comments (notes) for one issue
app.put('/api/notes', (req, res) => {
  const { projectKey, sprintName, issueKey, text } = req.body || {};
  if (!projectKey || !sprintName || !issueKey) {
    return res.status(400).json({ error: 'Missing projectKey, sprintName, or issueKey' });
  }
  const all = loadAllBuckets();
  const sk = sprintKey(projectKey, sprintName);
  const bucket = normalizeBucket(all[sk]);
  if ((text ?? '').toString().trim() === '') {
    delete bucket.notes[issueKey];
  } else {
    bucket.notes[issueKey] = text;
  }
  all[sk] = bucket;
  saveAllBuckets(all);
  res.json({ ok: true });
});

// Update blocker flag for one issue
app.put('/api/blocker', (req, res) => {
  const { projectKey, sprintName, issueKey, blocked } = req.body || {};
  if (!projectKey || !sprintName || !issueKey) {
    return res.status(400).json({ error: 'Missing projectKey, sprintName, or issueKey' });
  }
  const all = loadAllBuckets();
  const sk = sprintKey(projectKey, sprintName);
  const bucket = normalizeBucket(all[sk]);

  if (!!blocked) bucket.blockers[issueKey] = true;
  else delete bucket.blockers[issueKey];

  all[sk] = bucket;
  saveAllBuckets(all);
  res.json({ ok: true });
});

// ---------------- Search issues ----------------
app.post('/api/search', async (req, res) => {
  try {
    const {
      jql,
      fields = [
        'summary','issuetype','status','assignee','reporter','priority',
        'created','updated','duedate','parent',
        'components',
        'customfield_10020',      // Sprint
        'customfield_10014',      // Epic Link
        'customfield_10002',      // Story Points (CF10002)
        'customfield_10705',      // Parent Summary (CF10705)
        'customfield_16002',      // Parent Story Points (CF16002)
        'customfield_16000',      // Go Live Status (CF16000)
        'customfield_16001',      // Parent Go Live Status (CF16001)
        'timeoriginalestimate','timeestimate','timespent'
      ],
      maxResults = 100
    } = req.body;

    if (!jql) return res.status(400).json({ error: 'Missing jql' });
    console.log('JQL:', jql);

    let startAt = 0;
    let all = [];

    while (true) {
      const { data } = await jira.post('/rest/api/2/search', {
        jql,
        startAt,
        maxResults,
        fields
      });

      all = all.concat(data.issues || []);
      if (startAt + (data.issues?.length || 0) >= data.total) break;
      startAt += (data.issues?.length || 0);
    }

    res.json({ issues: all });
  } catch (e) {
    console.error('❌ Error fetching issues:', e.response?.status, e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || { error: String(e) });
  }
});

const port = PORT || 3001;
app.listen(port, () => console.log(`✅ API listening on http://localhost:${port}`));
