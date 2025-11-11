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
  console.error('❌ Missing JIRA_BASE_URL or JIRA_TOKEN in .env');
  process.exit(1);
}

// Jira client
const jira = axios.create({
  baseURL: JIRA_BASE_URL.replace(/\/$/, ''),
  headers: { Authorization: `Bearer ${JIRA_TOKEN}` },
  timeout: 30000
});

// Notes storage (simple JSON file)
const NOTES_FILE = path.join(__dirname, 'notes.json');
function loadNotesFile() {
  try {
    if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, JSON.stringify({}, null, 2));
    return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8') || '{}');
  } catch (e) {
    console.error('Failed to load notes file:', e);
    return {};
  }
}
function saveNotesFile(obj) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(obj, null, 2));
}
function sprintKey(projectKey, sprintName) {
  return `${projectKey}|||${sprintName}`;
}

// Request log
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Me
app.get('/api/me', async (_req, res) => {
  try {
    const { data } = await jira.get('/rest/api/2/myself');
    res.json({ ok: true, displayName: data.displayName, name: data.name || data.accountId });
  } catch (e) {
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

// Fields
app.get('/api/fields', async (_req, res) => {
  try {
    const { data } = await jira.get('/rest/api/2/field');
    res.json(data.map(f => ({ id: f.id, name: f.name, schema: f.schema })));
  } catch (e) {
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

// Projects
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

// ---- Sprints (scrum-only; skip kanban; fallback to issue scan) ----
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

    let list = Array.from(seen.values()).sort((a,b) => (a.name||'').localeCompare(b.name||''));

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

    res.json({ sprints: list });
  } catch (e) {
    console.error('sprints error', e.response?.status, e.response?.data || e.message);
    res.status(e.response?.status || 500).send(e.response?.data || e.message);
  }
});

// ---- Notes API ----
app.get('/api/notes', (req, res) => {
  const { project, sprint } = req.query;
  if (!project || !sprint) return res.status(400).json({ error: 'Missing project or sprint' });
  const all = loadNotesFile();
  const bucket = all[sprintKey(project, sprint)] || {};
  res.json({ notes: bucket });
});

app.put('/api/notes', (req, res) => {
  const { projectKey, sprintName, issueKey, text } = req.body || {};
  if (!projectKey || !sprintName || !issueKey) {
    return res.status(400).json({ error: 'Missing projectKey, sprintName, or issueKey' });
  }
  const all = loadNotesFile();
  const sk = sprintKey(projectKey, sprintName);
  all[sk] = all[sk] || {};
  if ((text ?? '').toString().trim() === '') {
    delete all[sk][issueKey];
  } else {
    all[sk][issueKey] = text;
  }
  saveNotesFile(all);
  res.json({ ok: true });
});

// ---- Search issues ----
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
