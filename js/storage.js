/* ══════════════════════════════════════════
   js/storage.js
   Session-based Q&A storage.

   Priority order:
     1. Local server  (data/qa_log.json — persistent on disk)
     2. Supabase      (cross-user, real database)
     3. Google Sheets (cross-user, spreadsheet)
     4. localStorage  (current browser only — fallback)

   Every question is stored in ALL available
   backends simultaneously.

   Run `node server.js` to enable disk persistence.
   ══════════════════════════════════════════ */

const Storage = (() => {

  /* ── Session ID ────────────────────────────────────────────────────────
     Generated once per page load. Groups questions from the same visit. */
  const SESSION_ID = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  /* ── Build a log entry object ── */
  function makeEntry(question, coverage, missingConcepts, answer, source, ontologyName) {
    return {
      session_id      : SESSION_ID,
      timestamp       : new Date().toISOString(),
      question,
      coverage        : coverage || 'unknown',
      missing_concepts: missingConcepts || [],
      answer          : (answer || '').substring(0, 800),
      source          : source || 'gemini',
      ontology_name   : ontologyName || '',
    };
  }

  /* ── Local server API ─────────────────────────────────────────────────
     Used when `node server.js` is running. Saves to data/qa_log.json.
     Silently skipped when not available (e.g. opening index.html as file). */
  const SERVER_BASE = (location.protocol !== 'file:') ? '' : null;

  async function saveServer(entry) {
    if (SERVER_BASE === null) return;
    try {
      await fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch { /* server not running — silent */ }
  }

  async function fetchServer() {
    if (SERVER_BASE === null) return null;
    try {
      const r = await fetch('/api/log');
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data) ? data : null;
    } catch { return null; }
  }

  async function clearServer() {
    if (SERVER_BASE === null) return;
    try { await fetch('/api/log', { method: 'DELETE' }); } catch {}
  }

  /* ── localStorage ──────────────────────────────────────────────────────
     Always used — the fallback layer. */
  function saveLocal(entry) {
    try {
      const log = JSON.parse(localStorage.getItem(CFG.KEY_LOG) || '[]');
      log.push(entry);
      localStorage.setItem(CFG.KEY_LOG, JSON.stringify(log));
    } catch (e) {
      console.warn('localStorage write failed:', e);
    }
  }

  function getLocal() {
    try {
      return JSON.parse(localStorage.getItem(CFG.KEY_LOG) || '[]');
    } catch {
      return [];
    }
  }

  /* ── Supabase ──────────────────────────────────────────────────────────
     INSERT into the qa_log table.
     Set up table with the SQL in README.md first. */
  async function saveSupabase(entry) {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return;

    try {
      await fetch(`${CFG.SUPABASE_URL}/rest/v1/qa_log`, {
        method: 'POST',
        headers: {
          'apikey'       : CFG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`,
          'Content-Type' : 'application/json',
          'Prefer'       : 'return=minimal',
        },
        body: JSON.stringify({
          session_id      : entry.session_id,
          question        : entry.question,
          coverage        : entry.coverage,
          missing_concepts: entry.missing_concepts,
          answer          : entry.answer,
          source          : entry.source,
          ontology_name   : entry.ontology_name,
        }),
      });
    } catch (e) {
      console.warn('Supabase write failed (non-critical):', e.message);
    }
  }

  async function fetchSupabase() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return null;
    try {
      const r = await fetch(
        `${CFG.SUPABASE_URL}/rest/v1/qa_log?order=created_at.desc&limit=500`,
        {
          headers: {
            'apikey'       : CFG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`,
          },
        }
      );
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async function saveSupabaseProposal(proposal) {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return;
    try {
      await fetch(`${CFG.SUPABASE_URL}/rest/v1/proposals`, {
        method: 'POST',
        headers: {
          'apikey'       : CFG.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`,
          'Content-Type' : 'application/json',
          'Prefer'       : 'return=minimal',
        },
        body: JSON.stringify({
          session_id     : SESSION_ID,
          concept_name   : proposal.name,
          concept_type   : proposal.type,
          parent_class   : proposal.parent,
          description    : proposal.desc,
          example        : proposal.example,
          context_question: proposal.ctx,
        }),
      });
    } catch (e) {
      console.warn('Supabase proposal write failed:', e.message);
    }
  }

  async function fetchSupabaseProposals() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return null;
    try {
      const r = await fetch(
        `${CFG.SUPABASE_URL}/rest/v1/proposals?order=created_at.desc&limit=200`,
        {
          headers: {
            'apikey'       : CFG.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${CFG.SUPABASE_ANON_KEY}`,
          },
        }
      );
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  /* ── Google Sheets ─────────────────────────────────────────────────────
     Fires a POST to your Apps Script web app URL.
     Silent failure — never blocks the UI. */
  async function saveSheet(entry) {
    if (!CFG.SHEET_URL) return;
    try {
      // no-cors + text/plain avoids the CORS preflight that Apps Script blocks.
      // We can't read the response, but the row is still written to the sheet.
      await fetch(CFG.SHEET_URL, {
        method  : 'POST',
        mode    : 'no-cors',
        body    : JSON.stringify(entry),
        headers : { 'Content-Type': 'text/plain' },
      });
    } catch (e) {
      console.warn('Google Sheets write failed (non-critical):', e.message);
    }
  }

  /* ── Public: save a Q&A entry everywhere ── */
  async function log(question, coverage, missingConcepts, answer, source, ontologyName) {
    const entry = makeEntry(question, coverage, missingConcepts, answer, source, ontologyName);
    saveLocal(entry);
    // fire-and-forget — don't await, never block the UI
    saveServer(entry).catch(() => {});
    saveSupabase(entry).catch(() => {});
    saveSheet(entry).catch(() => {});
    return entry;
  }

  /* ── Public: proposals ── */
  function saveProposalLocal(proposal) {
    try {
      const props = JSON.parse(localStorage.getItem(CFG.KEY_PROPOSALS) || '[]');
      props.push({ ...proposal, session_id: SESSION_ID, ts: new Date().toISOString() });
      localStorage.setItem(CFG.KEY_PROPOSALS, JSON.stringify(props));
    } catch (e) {
      console.warn('Proposal localStorage write failed:', e);
    }
  }

  async function saveSheetProposal(proposal) {
    if (!CFG.SHEET_URL) return;
    try {
      await fetch(CFG.SHEET_URL, {
        method  : 'POST',
        mode    : 'no-cors',
        body    : JSON.stringify({
          _type            : 'proposal',
          timestamp        : new Date().toISOString(),
          session_id       : SESSION_ID,
          name             : proposal.name     || '',
          type             : proposal.type     || '',
          parent           : proposal.parent   || '',
          description      : proposal.desc     || '',
          example          : proposal.example  || '',
          notes            : proposal.notes    || '',
          context_question : proposal.ctx      || '',
          coverage_context : proposal.coverage_context || '',
          missing_context  : (proposal.missing_context || []).join('; '),
          ontology_name    : proposal.ontology_name || '',
        }),
        headers : { 'Content-Type': 'text/plain' },
      });
    } catch (e) {
      console.warn('Google Sheets proposal write failed (non-critical):', e.message);
    }
  }

  async function saveProposal(proposal) {
    saveProposalLocal(proposal);
    saveSupabaseProposal(proposal).catch(() => {});
    saveSheetProposal(proposal).catch(() => {});
  }

  /* ── Public: read log for admin ────────────────────────────────────────
     When server is available: merge server + localStorage so no history
     is lost, and auto-migrate any localStorage-only entries to the server.
     Falls back to Supabase → localStorage when server is unreachable. */
  async function readLog() {
    const server = await fetchServer();

    if (server !== null) {
      const local      = getLocal();
      const serverKeys = new Set(server.map(e => e.timestamp + '|' + e.question));
      const localOnly  = local.filter(e => !serverKeys.has(e.timestamp + '|' + e.question));
      // Silently migrate localStorage-only entries to the server file
      for (const e of localOnly) saveServer(e).catch(() => {});
      // Return all entries sorted oldest → newest
      return [...server, ...localOnly].sort((a, b) =>
        (a.timestamp || '') < (b.timestamp || '') ? -1 : 1
      );
    }

    const remote = await fetchSupabase();
    if (remote && remote.length) {
      return remote.map(r => ({
        session_id      : r.session_id,
        timestamp       : r.created_at,
        question        : r.question,
        coverage        : r.coverage,
        missing_concepts: r.missing_concepts || [],
        answer          : r.answer,
        source          : r.source,
        ontology_name   : r.ontology_name,
      }));
    }
    return getLocal();
  }

  async function readProposals() {
    const remote = await fetchSupabaseProposals();
    if (remote && remote.length) return remote;
    try { return JSON.parse(localStorage.getItem(CFG.KEY_PROPOSALS) || '[]'); }
    catch { return []; }
  }

  /* ── Clear local data ── */
  function clearLocal() {
    localStorage.removeItem(CFG.KEY_LOG);
    localStorage.removeItem(CFG.KEY_PROPOSALS);
    clearServer().catch(() => {});
  }

  /* ── Export helpers ── */
  function toCSV(log) {
    const hdr = 'timestamp,session_id,question,coverage,missing_concepts,answer\n';
    const rows = log.map(l => [
      l.timestamp,
      l.session_id,
      `"${(l.question || '').replace(/"/g, '""')}"`,
      l.coverage,
      `"${(l.missing_concepts || []).join('; ')}"`,
      `"${(l.answer || '').replace(/"/g, '""').substring(0, 400)}"`,
    ].join(',')).join('\n');
    return hdr + rows;
  }

  function toJSON(log) {
    return JSON.stringify(log, null, 2);
  }

  function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return {
    SESSION_ID,
    log,
    saveProposal,
    saveNote,
    readLog,
    readProposals,
    clearLocal,
    toCSV,
    toJSON,
    downloadFile,
  };

})();

  /* ── Save note attached to a log entry ── */
  function saveNote(idx, note, entry) {
    // Update localStorage log
    try {
      const log = JSON.parse(localStorage.getItem(CFG.KEY_LOG) || '[]');
      // Find matching entry by timestamp
      const match = log.findIndex(l => l.timestamp === entry.timestamp && l.question === entry.question);
      if (match >= 0) {
        log[match].note = note;
        localStorage.setItem(CFG.KEY_LOG, JSON.stringify(log));
      }
    } catch(e) { console.warn('Note save failed:', e); }

    // Push to Supabase if configured (fire and forget)
    if (CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) {
      fetch(CFG.SUPABASE_URL + '/rest/v1/proposals', {
        method: 'POST',
        headers: {
          'apikey': CFG.SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + CFG.SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          concept_name: 'USER_NOTE',
          concept_type: 'note',
          description: note,
          context_question: entry.question,
        }),
      }).catch(() => {});
    }
  }

