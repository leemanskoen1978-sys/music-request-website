const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SONGS_FILE = path.join(__dirname, 'data', 'songs.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY STATE =====
let isWriting = false;
const adminTokens = new Set();
const userVotes = {}; // { userId: [songId, songId, ...] }
const MAX_VOTES = 5;
const sseClients = []; // SSE connections
let activeCelebration = null; // { message, type } or null

// ===== FILE HELPERS =====
function readSongs() {
  return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf-8'));
}

function writeSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2), 'utf-8');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ===== WRITE LOCK HELPER =====
async function acquireLock() {
  let attempts = 0;
  while (isWriting && attempts < 20) {
    await new Promise(r => setTimeout(r, 50));
    attempts++;
  }
  isWriting = true;
}

function releaseLock() {
  isWriting = false;
}

// ===== ADMIN AUTH MIDDLEWARE =====
function requireAdmin(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===== SSE: BROADCAST =====
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ===== TIMER CHECK =====
function isTimerExpired() {
  const config = readConfig();
  if (!config.timer.active || !config.timer.endsAt) return false;
  return new Date() >= new Date(config.timer.endsAt);
}

function isVotingClosed() {
  const config = readConfig();
  if (!config.timer.active) return false;
  if (!config.timer.endsAt) return false;
  return new Date() >= new Date(config.timer.endsAt);
}

// ==========================================
// PUBLIC ENDPOINTS
// ==========================================

// GET /api/songs - all active songs (excludes played)
app.get('/api/songs', (req, res) => {
  const songs = readSongs();
  const includeAll = req.query.includeAll === 'true';
  const filtered = includeAll ? songs : songs.filter(s => !s.played);
  filtered.sort((a, b) => a.artist.localeCompare(b.artist));
  res.json(filtered);
});

// GET /api/top10 - top 10 most voted (excludes played)
app.get('/api/top10', (req, res) => {
  const songs = readSongs();
  const top10 = songs
    .filter(s => s.votes > 0 && !s.played)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 10);
  res.json(top10);
});

// POST /api/songs/:id/vote - vote with user tracking
app.post('/api/songs/:id/vote', async (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(400).json({ error: 'Missing X-User-Id header' });
  }

  // Check timer
  if (isVotingClosed()) {
    return res.status(403).json({ error: 'Stemmen is gesloten!' });
  }

  // Check vote limit
  if (!userVotes[userId]) userVotes[userId] = [];
  if (userVotes[userId].length >= MAX_VOTES) {
    return res.status(403).json({ error: `Je hebt al ${MAX_VOTES} stemmen gebruikt!` });
  }

  await acquireLock();
  try {
    const songs = readSongs();
    const song = songs.find(s => s.id === songId);
    if (!song) return res.status(404).json({ error: 'Song not found' });
    if (song.played) return res.status(400).json({ error: 'Dit nummer is al gespeeld' });

    song.votes += 1;
    userVotes[userId].push(songId);
    writeSongs(songs);

    console.log(`Vote: "${song.title}" by ${song.artist} → ${song.votes} votes (user: ${userId.slice(0, 8)}...)`);

    // Broadcast vote event via SSE
    broadcast('vote', {
      songId: song.id,
      title: song.title,
      artist: song.artist,
      votes: song.votes,
      userId: userId.slice(0, 8)
    });

    res.json({ song, votesUsed: userVotes[userId].length, maxVotes: MAX_VOTES });
  } finally {
    releaseLock();
  }
});

// GET /api/votes-used - get votes used by user
app.get('/api/votes-used', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.json({ votesUsed: 0, maxVotes: MAX_VOTES });
  const used = userVotes[userId]?.length || 0;
  res.json({ votesUsed: used, maxVotes: MAX_VOTES });
});

// GET /api/timer - current timer status
app.get('/api/timer', (req, res) => {
  const config = readConfig();
  res.json(config.timer);
});

// GET /api/events - SSE stream
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  sseClients.push(res);
  req.on('close', () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const config = readConfig();
  if (password !== config.adminPassword) {
    return res.status(401).json({ error: 'Onjuist wachtwoord' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const songs = readSongs();
  const totalSongs = songs.length;
  const activeSongs = songs.filter(s => !s.played).length;
  const playedSongs = songs.filter(s => s.played).length;
  const totalVotes = songs.reduce((sum, s) => sum + s.votes, 0);
  const activeUsers = Object.keys(userVotes).length;
  res.json({ totalSongs, activeSongs, playedSongs, totalVotes, activeUsers });
});

// GET /api/admin/export-csv - export songs as CSV (supports ?token= for download link)
app.get('/api/admin/export-csv', (req, res, next) => {
  // Allow token via query param for direct download links
  if (req.query.token && adminTokens.has(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const songs = readSongs();
  const header = 'title,artist,youtubeId,genre,votes,played';
  const rows = songs.map(s => {
    const title = `"${s.title.replace(/"/g, '""')}"`;
    const artist = `"${s.artist.replace(/"/g, '""')}"`;
    return `${title},${artist},${s.youtubeId},${s.genre},${s.votes},${s.played}`;
  });
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="songlist.csv"');
  res.send(csv);
});

// POST /api/admin/import-csv - import songs from CSV
app.post('/api/admin/import-csv', requireAdmin, async (req, res) => {
  const { csv, mode } = req.body; // mode: 'append' or 'replace'
  if (!csv) return res.status(400).json({ error: 'CSV data is verplicht' });

  const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV moet minstens een header en 1 rij hebben' });

  // Parse header
  const header = lines[0].toLowerCase();
  if (!header.includes('title') || !header.includes('artist')) {
    return res.status(400).json({ error: 'CSV moet minstens "title" en "artist" kolommen hebben' });
  }

  const cols = header.split(',').map(c => c.trim().replace(/"/g, ''));
  const titleIdx = cols.indexOf('title');
  const artistIdx = cols.indexOf('artist');
  const youtubeIdx = cols.indexOf('youtubeid');
  const genreIdx = cols.indexOf('genre');

  // Parse rows
  function parseCSVRow(row) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '"') {
        if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (row[i] === ',' && !inQuotes) {
        result.push(current.trim()); current = '';
      } else { current += row[i]; }
    }
    result.push(current.trim());
    return result;
  }

  const newSongs = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVRow(lines[i]);
    const title = fields[titleIdx];
    const artist = fields[artistIdx];
    if (!title || !artist) continue;
    newSongs.push({
      title,
      artist,
      youtubeId: (youtubeIdx >= 0 ? fields[youtubeIdx] : '') || '',
      genre: (genreIdx >= 0 ? fields[genreIdx] : '') || 'Pop',
    });
  }

  if (newSongs.length === 0) return res.status(400).json({ error: 'Geen geldige rijen gevonden' });

  await acquireLock();
  try {
    let songs = mode === 'replace' ? [] : readSongs();
    const maxId = songs.reduce((max, s) => Math.max(max, s.id), 0);
    newSongs.forEach((s, i) => {
      songs.push({ id: maxId + 1 + i, ...s, votes: 0, played: false });
    });
    writeSongs(songs);
    console.log(`Admin: Imported ${newSongs.length} songs (mode: ${mode || 'append'})`);
    broadcast('songAdded', {});
    res.json({ imported: newSongs.length });
  } finally {
    releaseLock();
  }
});

// POST /api/admin/songs - add song
app.post('/api/admin/songs', requireAdmin, async (req, res) => {
  const { title, artist, youtubeId, genre } = req.body;
  if (!title || !artist || !youtubeId || !genre) {
    return res.status(400).json({ error: 'Alle velden zijn verplicht' });
  }

  await acquireLock();
  try {
    const songs = readSongs();
    const maxId = songs.reduce((max, s) => Math.max(max, s.id), 0);
    const newSong = {
      id: maxId + 1,
      title,
      artist,
      youtubeId,
      genre,
      votes: 0,
      played: false
    };
    songs.push(newSong);
    writeSongs(songs);
    console.log(`Admin: Added "${title}" by ${artist}`);
    broadcast('songAdded', newSong);
    res.json(newSong);
  } finally {
    releaseLock();
  }
});

// DELETE /api/admin/songs/:id
app.delete('/api/admin/songs/:id', requireAdmin, async (req, res) => {
  const songId = parseInt(req.params.id, 10);

  await acquireLock();
  try {
    let songs = readSongs();
    const song = songs.find(s => s.id === songId);
    if (!song) return res.status(404).json({ error: 'Song not found' });

    songs = songs.filter(s => s.id !== songId);
    writeSongs(songs);
    console.log(`Admin: Deleted "${song.title}" by ${song.artist}`);
    broadcast('songRemoved', { id: songId });
    res.json({ success: true });
  } finally {
    releaseLock();
  }
});

// POST /api/admin/songs/:id/played - mark as played
app.post('/api/admin/songs/:id/played', requireAdmin, async (req, res) => {
  const songId = parseInt(req.params.id, 10);

  await acquireLock();
  try {
    const songs = readSongs();
    const song = songs.find(s => s.id === songId);
    if (!song) return res.status(404).json({ error: 'Song not found' });

    song.played = true;
    writeSongs(songs);
    console.log(`Admin: Marked "${song.title}" as played`);
    broadcast('songPlayed', { id: songId, title: song.title, artist: song.artist });
    res.json(song);
  } finally {
    releaseLock();
  }
});

// POST /api/admin/reset-votes
app.post('/api/admin/reset-votes', requireAdmin, async (req, res) => {
  await acquireLock();
  try {
    const songs = readSongs();
    songs.forEach(s => s.votes = 0);
    writeSongs(songs);
    // Clear user vote tracking
    Object.keys(userVotes).forEach(k => delete userVotes[k]);
    console.log('Admin: All votes reset');
    broadcast('votesReset', {});
    res.json({ success: true });
  } finally {
    releaseLock();
  }
});

// POST /api/admin/timer
app.post('/api/admin/timer', requireAdmin, (req, res) => {
  const config = readConfig();
  const { minutes, stop } = req.body;

  if (stop) {
    config.timer = { active: false, endsAt: null };
    writeConfig(config);
    broadcast('timer', config.timer);
    console.log('Admin: Timer stopped');
    return res.json(config.timer);
  }

  if (minutes && minutes > 0) {
    const endsAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    config.timer = { active: true, endsAt };
    writeConfig(config);
    broadcast('timer', config.timer);
    console.log(`Admin: Timer set for ${minutes} minutes`);
    return res.json(config.timer);
  }

  res.status(400).json({ error: 'Geef minutes of stop op' });
});

// GET /api/celebration - current celebration state (polling fallback)
app.get('/api/celebration', (req, res) => {
  res.json(activeCelebration || { active: false });
});

// POST /api/admin/celebrate - trigger celebration on all screens
app.post('/api/admin/celebrate', requireAdmin, (req, res) => {
  const { message, type } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Bericht is verplicht' });
  }
  const celebrationType = type || 'custom';
  activeCelebration = { active: true, message, type: celebrationType };
  console.log(`Admin: Celebration triggered — "${message}" (${celebrationType})`);
  broadcast('celebrate', { message, type: celebrationType });
  res.json({ success: true });
});

// POST /api/admin/celebrate/stop - dismiss celebration on all screens
app.post('/api/admin/celebrate/stop', requireAdmin, (req, res) => {
  activeCelebration = null;
  broadcast('celebrateStop', {});
  console.log('Admin: Celebration dismissed');
  res.json({ success: true });
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`🎵 Music Request Server running on http://localhost:${PORT}`);
  console.log(`🔑 Admin panel: http://localhost:${PORT}/admin.html`);
});
