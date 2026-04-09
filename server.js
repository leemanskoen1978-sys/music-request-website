const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'music.db');
const SONGS_JSON = path.join(__dirname, 'data', 'songs.json');
const CONFIG_JSON = path.join(__dirname, 'data', 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== DATABASE SETUP =====
const db = new Database(DB_PATH, { wal: true }); // WAL mode for concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    youtubeId TEXT DEFAULT '',
    genre TEXT DEFAULT 'Pop',
    votes INTEGER DEFAULT 0,
    played INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    songId INTEGER NOT NULL,
    createdAt TEXT DEFAULT (datetime('now')),
    UNIQUE(userId, songId)
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_user_votes_userId ON user_votes(userId);
  CREATE INDEX IF NOT EXISTS idx_songs_played ON songs(played);
  CREATE INDEX IF NOT EXISTS idx_songs_votes ON songs(votes DESC);
`);

// ===== SCHEMA MIGRATIONS =====
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}
if (!columnExists('songs', 'setlistPosition')) {
  db.exec('ALTER TABLE songs ADD COLUMN setlistPosition INTEGER DEFAULT NULL');
  console.log('Migration: added setlistPosition column to songs');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_songs_setlist ON songs(setlistPosition)');

// ===== AUTO-MIGRATE FROM JSON =====
function migrateFromJSON() {
  const songCount = db.prepare('SELECT COUNT(*) as count FROM songs').get().count;
  if (songCount > 0) return; // Already has data

  // Migrate songs
  if (fs.existsSync(SONGS_JSON)) {
    const songs = JSON.parse(fs.readFileSync(SONGS_JSON, 'utf-8'));
    const insert = db.prepare(
      'INSERT INTO songs (id, title, artist, youtubeId, genre, votes, played) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const migrate = db.transaction(() => {
      for (const s of songs) {
        insert.run(s.id, s.title, s.artist, s.youtubeId || '', s.genre || 'Pop', s.votes || 0, s.played ? 1 : 0);
      }
    });
    migrate();
    console.log(`Migrated ${songs.length} songs from JSON to SQLite`);
  }

  // Migrate config
  if (fs.existsSync(CONFIG_JSON)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf-8'));
    const upsert = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    upsert.run('adminPassword', config.adminPassword || 'admin123');
    upsert.run('timerActive', config.timer?.active ? '1' : '0');
    upsert.run('timerEndsAt', config.timer?.endsAt || '');
    console.log('Migrated config from JSON to SQLite');
  } else {
    // Default config
    const upsert = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    upsert.run('adminPassword', 'admin123');
    upsert.run('timerActive', '0');
    upsert.run('timerEndsAt', '');
  }
}

migrateFromJSON();

// ===== IN-MEMORY STATE (non-persistent) =====
const adminTokens = new Set();
const sseClients = [];
let activeCelebration = null;
const MAX_VOTES = 5;

// ===== PREPARED STATEMENTS =====
const stmts = {
  allSongs: db.prepare('SELECT * FROM songs ORDER BY artist COLLATE NOCASE'),
  activeSongs: db.prepare('SELECT * FROM songs WHERE played = 0 ORDER BY artist COLLATE NOCASE'),
  top10: db.prepare('SELECT * FROM songs WHERE votes > 0 AND played = 0 ORDER BY votes DESC LIMIT 10'),
  setlist: db.prepare('SELECT * FROM songs WHERE setlistPosition IS NOT NULL ORDER BY setlistPosition ASC'),
  clearSetlist: db.prepare('UPDATE songs SET setlistPosition = NULL'),
  setSetlistPosition: db.prepare('UPDATE songs SET setlistPosition = ? WHERE id = ?'),
  removeFromSetlist: db.prepare('UPDATE songs SET setlistPosition = NULL WHERE id = ?'),
  songById: db.prepare('SELECT * FROM songs WHERE id = ?'),
  incrementVote: db.prepare('UPDATE songs SET votes = votes + 1 WHERE id = ?'),
  addVote: db.prepare('INSERT OR IGNORE INTO user_votes (userId, songId) VALUES (?, ?)'),
  userVoteCount: db.prepare('SELECT COUNT(*) as count FROM user_votes WHERE userId = ?'),
  hasUserVoted: db.prepare('SELECT 1 FROM user_votes WHERE userId = ? AND songId = ?'),
  markPlayed: db.prepare('UPDATE songs SET played = 1, setlistPosition = NULL WHERE id = ?'),
  deleteSong: db.prepare('DELETE FROM songs WHERE id = ?'),
  resetVotes: db.prepare('UPDATE songs SET votes = 0'),
  clearUserVotes: db.prepare('DELETE FROM user_votes'),
  addSong: db.prepare('INSERT INTO songs (title, artist, youtubeId, genre, votes, played) VALUES (?, ?, ?, ?, 0, 0)'),
  getConfig: db.prepare('SELECT value FROM config WHERE key = ?'),
  setConfig: db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'),
  stats: db.prepare(`
    SELECT
      COUNT(*) as totalSongs,
      SUM(CASE WHEN played = 0 THEN 1 ELSE 0 END) as activeSongs,
      SUM(CASE WHEN played = 1 THEN 1 ELSE 0 END) as playedSongs,
      SUM(votes) as totalVotes
    FROM songs
  `),
  activeUsers: db.prepare('SELECT COUNT(DISTINCT userId) as count FROM user_votes'),
};

// ===== HELPERS =====
function getConfig(key) {
  const row = stmts.getConfig.get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  stmts.setConfig.run(key, value);
}

function getTimer() {
  return {
    active: getConfig('timerActive') === '1',
    endsAt: getConfig('timerEndsAt') || null,
  };
}

function isVotingClosed() {
  const timer = getTimer();
  if (!timer.active || !timer.endsAt) return false;
  return new Date() >= new Date(timer.endsAt);
}

function songRow(s) {
  return { ...s, played: !!s.played };
}

// ===== ADMIN AUTH =====
function requireAdmin(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ===== SSE =====
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

// ==========================================
// PUBLIC ENDPOINTS
// ==========================================

app.get('/api/songs', (req, res) => {
  const includeAll = req.query.includeAll === 'true';
  const songs = includeAll ? stmts.allSongs.all() : stmts.activeSongs.all();
  res.json(songs.map(songRow));
});

app.get('/api/top10', (req, res) => {
  res.json(stmts.top10.all().map(songRow));
});

app.get('/api/setlist', (req, res) => {
  const songs = stmts.setlist.all().map(songRow);
  const nowPlayingId = parseInt(getConfig('nowPlayingId') || '0', 10) || null;
  res.json({ songs, nowPlayingId });
});

app.post('/api/songs/:id/vote', (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const userId = req.headers['x-user-id'];

  if (!userId) return res.status(400).json({ error: 'Missing X-User-Id header' });
  if (isVotingClosed()) return res.status(403).json({ error: 'Stemmen is gesloten!' });

  const voteCount = stmts.userVoteCount.get(userId).count;
  if (voteCount >= MAX_VOTES) {
    return res.status(403).json({ error: `Je hebt al ${MAX_VOTES} stemmen gebruikt!` });
  }

  const song = stmts.songById.get(songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  if (song.played) return res.status(400).json({ error: 'Dit nummer is al gespeeld' });

  // Check if already voted for this song
  if (stmts.hasUserVoted.get(userId, songId)) {
    return res.status(400).json({ error: 'Je hebt al op dit nummer gestemd' });
  }

  // Atomic: increment vote + record user vote in a transaction
  const doVote = db.transaction(() => {
    stmts.incrementVote.run(songId);
    stmts.addVote.run(userId, songId);
  });
  doVote();

  const updatedSong = stmts.songById.get(songId);
  const newVoteCount = stmts.userVoteCount.get(userId).count;

  console.log(`Vote: "${updatedSong.title}" by ${updatedSong.artist} → ${updatedSong.votes} votes (user: ${userId.slice(0, 8)}...)`);

  broadcast('vote', {
    songId: updatedSong.id,
    title: updatedSong.title,
    artist: updatedSong.artist,
    votes: updatedSong.votes,
    userId: userId.slice(0, 8)
  });

  res.json({ song: songRow(updatedSong), votesUsed: newVoteCount, maxVotes: MAX_VOTES });
});

app.get('/api/votes-used', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.json({ votesUsed: 0, maxVotes: MAX_VOTES });
  const count = stmts.userVoteCount.get(userId).count;
  res.json({ votesUsed: count, maxVotes: MAX_VOTES });
});

app.get('/api/timer', (req, res) => {
  res.json(getTimer());
});

app.get('/api/celebration', (req, res) => {
  res.json(activeCelebration || { active: false });
});

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

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPw = getConfig('adminPassword');
  if (password !== adminPw) {
    return res.status(401).json({ error: 'Onjuist wachtwoord' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const s = stmts.stats.get();
  const activeUsers = stmts.activeUsers.get().count;
  res.json({
    totalSongs: s.totalSongs,
    activeSongs: s.activeSongs,
    playedSongs: s.playedSongs,
    totalVotes: s.totalVotes || 0,
    activeUsers,
  });
});

app.get('/api/admin/export-csv', (req, res, next) => {
  if (req.query.token && adminTokens.has(req.query.token)) return next();
  return requireAdmin(req, res, next);
}, (req, res) => {
  const songs = stmts.allSongs.all();
  const header = 'title,artist,youtubeId,genre,votes,played';
  const rows = songs.map(s => {
    const title = `"${s.title.replace(/"/g, '""')}"`;
    const artist = `"${s.artist.replace(/"/g, '""')}"`;
    return `${title},${artist},${s.youtubeId},${s.genre},${s.votes},${!!s.played}`;
  });
  const csv = [header, ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="songlist.csv"');
  res.send(csv);
});

app.post('/api/admin/import-csv', requireAdmin, (req, res) => {
  const { csv, mode } = req.body;
  if (!csv) return res.status(400).json({ error: 'CSV data is verplicht' });

  const lines = csv.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV moet minstens een header en 1 rij hebben' });

  const headerLine = lines[0].toLowerCase();
  if (!headerLine.includes('title') || !headerLine.includes('artist')) {
    return res.status(400).json({ error: 'CSV moet minstens "title" en "artist" kolommen hebben' });
  }

  const cols = headerLine.split(',').map(c => c.trim().replace(/"/g, ''));
  const titleIdx = cols.indexOf('title');
  const artistIdx = cols.indexOf('artist');
  const youtubeIdx = cols.indexOf('youtubeid');
  const genreIdx = cols.indexOf('genre');

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

  const doImport = db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM songs').run();
      db.prepare('DELETE FROM user_votes').run();
    }
    for (const s of newSongs) {
      stmts.addSong.run(s.title, s.artist, s.youtubeId, s.genre);
    }
  });
  doImport();

  console.log(`Admin: Imported ${newSongs.length} songs (mode: ${mode || 'append'})`);
  broadcast('songAdded', {});
  res.json({ imported: newSongs.length });
});

app.post('/api/admin/songs', requireAdmin, (req, res) => {
  const { title, artist, youtubeId, genre } = req.body;
  if (!title || !artist || !youtubeId || !genre) {
    return res.status(400).json({ error: 'Alle velden zijn verplicht' });
  }

  const result = stmts.addSong.run(title, artist, youtubeId, genre);
  const newSong = stmts.songById.get(result.lastInsertRowid);
  console.log(`Admin: Added "${title}" by ${artist}`);
  broadcast('songAdded', songRow(newSong));
  res.json(songRow(newSong));
});

app.delete('/api/admin/songs/:id', requireAdmin, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const song = stmts.songById.get(songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  stmts.deleteSong.run(songId);
  console.log(`Admin: Deleted "${song.title}" by ${song.artist}`);
  broadcast('songRemoved', { id: songId });
  res.json({ success: true });
});

app.post('/api/admin/songs/:id/played', requireAdmin, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const song = stmts.songById.get(songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  stmts.markPlayed.run(songId);
  // If this song was the "now playing" indicator, clear it
  if (parseInt(getConfig('nowPlayingId') || '0', 10) === songId) {
    setConfig('nowPlayingId', '');
    broadcast('nowPlayingUpdated', { songId: null });
  }
  const updated = stmts.songById.get(songId);
  console.log(`Admin: Marked "${song.title}" as played`);
  broadcast('songPlayed', { id: songId, title: song.title, artist: song.artist });
  broadcast('setlistUpdated', {});
  res.json(songRow(updated));
});

// ===== SETLIST ADMIN =====
app.post('/api/admin/setlist', requireAdmin, (req, res) => {
  const { songIds } = req.body;
  if (!Array.isArray(songIds)) {
    return res.status(400).json({ error: 'songIds moet een array zijn' });
  }
  // Validate all IDs exist and are not played
  const tx = db.transaction(() => {
    stmts.clearSetlist.run();
    songIds.forEach((id, i) => {
      const song = stmts.songById.get(id);
      if (song && !song.played) stmts.setSetlistPosition.run(i, id);
    });
  });
  tx();
  console.log(`Admin: Setlist updated (${songIds.length} songs)`);
  broadcast('setlistUpdated', {});
  res.json({ success: true, count: songIds.length });
});

app.post('/api/admin/now-playing', requireAdmin, (req, res) => {
  const { songId } = req.body;
  if (songId == null || songId === '') {
    setConfig('nowPlayingId', '');
    broadcast('nowPlayingUpdated', { songId: null });
    console.log('Admin: Now playing cleared');
    return res.json({ success: true, songId: null });
  }
  const id = parseInt(songId, 10);
  const song = stmts.songById.get(id);
  if (!song) return res.status(404).json({ error: 'Song not found' });
  setConfig('nowPlayingId', String(id));
  broadcast('nowPlayingUpdated', { songId: id });
  console.log(`Admin: Now playing → "${song.title}"`);
  res.json({ success: true, songId: id });
});

app.post('/api/admin/reset-votes', requireAdmin, (req, res) => {
  const doReset = db.transaction(() => {
    stmts.resetVotes.run();
    stmts.clearUserVotes.run();
  });
  doReset();
  console.log('Admin: All votes reset');
  broadcast('votesReset', {});
  res.json({ success: true });
});

app.post('/api/admin/timer', requireAdmin, (req, res) => {
  const { minutes, stop } = req.body;

  if (stop) {
    setConfig('timerActive', '0');
    setConfig('timerEndsAt', '');
    const timer = { active: false, endsAt: null };
    broadcast('timer', timer);
    console.log('Admin: Timer stopped');
    return res.json(timer);
  }

  if (minutes && minutes > 0) {
    const endsAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    setConfig('timerActive', '1');
    setConfig('timerEndsAt', endsAt);
    const timer = { active: true, endsAt };
    broadcast('timer', timer);
    console.log(`Admin: Timer set for ${minutes} minutes`);
    return res.json(timer);
  }

  res.status(400).json({ error: 'Geef minutes of stop op' });
});

app.post('/api/admin/celebrate', requireAdmin, (req, res) => {
  const { message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'Bericht is verplicht' });
  const celebrationType = type || 'custom';
  activeCelebration = { active: true, message, type: celebrationType };
  console.log(`Admin: Celebration triggered — "${message}" (${celebrationType})`);
  broadcast('celebrate', { message, type: celebrationType });
  res.json({ success: true });
});

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
  console.log(`📀 Database: ${DB_PATH}`);
});

// Graceful shutdown
process.on('SIGINT', () => { db.close(); process.exit(); });
process.on('SIGTERM', () => { db.close(); process.exit(); });
