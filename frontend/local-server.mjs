import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 7200);
const dataDir = path.join(__dirname, 'data');
const playlistsPath = path.join(dataDir, 'playlists.json');

const neteaseHeaders = {
  Referer: 'https://music.163.com/',
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json, text/plain, */*',
  Connection: 'close',
};
const neteaseCookieHeader = 'x-netease-cookie';

const playableUrlCache = new Map();
const searchCache = new Map();
const playableUrlCacheTtl = 1000 * 60 * 10;
const searchCacheTtl = 1000 * 60 * 5;
let browserNeteaseCookie = '';

function normalizeNeteaseCookie(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/;+$/, ''))
    .filter(Boolean)
    .join('; ');
}

function readNeteaseCookie(req) {
  const raw = req.headers?.[neteaseCookieHeader];
  const headerCookie = Array.isArray(raw) ? raw[0] : String(raw || '');
  return normalizeNeteaseCookie(headerCookie || browserNeteaseCookie);
}

function createNeteaseHeaders(cookie, extraHeaders = {}) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  return {
    ...neteaseHeaders,
    ...(normalizedCookie ? { Cookie: normalizedCookie } : {}),
    ...extraHeaders,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, options = {}, retries = 2) {
  let lastData = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, options);
    const data = await response.json();
    lastData = data;
    if (response.ok && data?.code !== 400) return data;
    if (attempt < retries) await wait(180 * (attempt + 1));
  }
  return lastData || {};
}


async function getNeteasePlayableUrl(id, cookie = '') {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  const cacheKey = `${id}::${normalizedCookie}`;
  const cached = playableUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;

  const url = `https://music.163.com/api/song/enhance/player/url?id=${encodeURIComponent(id)}&ids=%5B${encodeURIComponent(id)}%5D&br=320000`;
  const data = await fetchJsonWithRetry(url, { headers: createNeteaseHeaders(normalizedCookie) });
  const playableUrl = data?.data?.[0]?.url || null;
  playableUrlCache.set(cacheKey, { url: playableUrl, expiresAt: Date.now() + playableUrlCacheTtl });
  return playableUrl;
}

function mapNeteaseSong(song) {
  const artists = song.artists || song.ar || [];
  const album = song.album || song.al || {};
  return {
    id: song.id,
    name: song.name,
    artist: artists.map((artist) => artist.name).filter(Boolean).join(' / '),
    album: album?.name || '',
    duration: song.duration || song.dt || 0,
    fee: song.fee,
  };
}

async function fetchNeteaseSearchSongs(keywords, resultLimit, cookie) {
  const upstreamLimit = Math.min(resultLimit * 5, 80);
  const body = new URLSearchParams({
    s: keywords,
    type: '1',
    offset: '0',
    total: 'true',
    limit: String(upstreamLimit),
    _: String(Date.now()),
  });

  const data = await fetchJsonWithRetry('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: createNeteaseHeaders(cookie, {
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    body,
  });
  const primarySongs = data?.result?.songs || [];

  const fallbackUrl = new URL('https://music.163.com/api/cloudsearch/pc');
  fallbackUrl.searchParams.set('s', keywords);
  fallbackUrl.searchParams.set('type', '1');
  fallbackUrl.searchParams.set('offset', '0');
  fallbackUrl.searchParams.set('total', 'true');
  fallbackUrl.searchParams.set('limit', String(upstreamLimit));
  fallbackUrl.searchParams.set('_', String(Date.now()));
  const fallbackData = await fetchJsonWithRetry(fallbackUrl, {
    headers: createNeteaseHeaders(cookie),
  });
  const fallbackSongs = fallbackData?.result?.songs || [];
  const songsById = new Map();
  for (const song of [...primarySongs, ...fallbackSongs]) {
    if (song?.id && !songsById.has(song.id)) songsById.set(song.id, song);
  }
  return {
    songs: [...songsById.values()],
    debug: {
      primaryCode: data?.code,
      primaryCount: primarySongs.length,
      fallbackCode: fallbackData?.code,
      fallbackCount: fallbackSongs.length,
    },
  };
}

async function fetchAnonymousNeteaseSearchSongs(keywords, resultLimit) {
  const body = new URLSearchParams({
    s: keywords,
    type: '1',
    offset: '0',
    total: 'true',
    limit: String(Math.min(resultLimit * 3, 60)),
  });

  const response = await fetch('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: {
      ...neteaseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await response.json();
  return data?.result?.songs || [];
}

async function validateNeteaseCookie(cookie) {
  const account = await getNeteaseAccount(cookie);
  return account.valid;
}

async function getNeteaseAccount(cookie) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  if (!normalizedCookie) return { valid: false, userId: null, nickname: '' };

  const response = await fetch('https://music.163.com/api/nuser/account/get', {
    headers: createNeteaseHeaders(normalizedCookie),
  });
  const data = await response.json();
  const userId = data?.profile?.userId || data?.account?.id || null;
  return {
    valid: Boolean(userId),
    userId,
    nickname: data?.profile?.nickname || '',
  };
}


async function filterPlayableSongs(rawSongs, resultLimit, cookie) {
  const playableSongs = [];
  const batchSize = 8;

  for (let i = 0; i < rawSongs.length && playableSongs.length < resultLimit; i += batchSize) {
    const batch = rawSongs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (song) => ({
      song,
      playableUrl: await getNeteasePlayableUrl(String(song.id), cookie),
    })));

    for (const result of results) {
      if (result.playableUrl) playableSongs.push(result.song);
      if (playableSongs.length >= resultLimit) break;
    }
  }

  return playableSongs;
}

async function getDailyRecommendSongs(cookie, resultLimit) {
  const normalizedCookie = normalizeNeteaseCookie(cookie);
  if (!normalizedCookie) return { valid: false, songs: [] };
  const validCookie = await validateNeteaseCookie(normalizedCookie);
  if (!validCookie) return { valid: false, songs: [] };

  const response = await fetch('https://music.163.com/api/v3/discovery/recommend/songs', {
    headers: createNeteaseHeaders(normalizedCookie),
  });
  const data = await response.json();
  const rawSongs = (data?.data?.dailySongs || data?.recommend || []).map(mapNeteaseSong);
  const songs = await filterPlayableSongs(rawSongs, resultLimit, normalizedCookie);
  return { valid: Boolean(data?.data?.dailySongs || data?.recommend), songs };
}

async function getUserPlaylists(cookie) {
  const account = await getNeteaseAccount(cookie);
  if (!account.valid || !account.userId) return { valid: false, playlists: [] };

  const response = await fetch(`https://music.163.com/api/user/playlist?uid=${encodeURIComponent(account.userId)}&limit=100&offset=0`, {
    headers: createNeteaseHeaders(cookie),
  });
  const data = await response.json();
  const playlists = (data?.playlist || []).map((playlist) => ({
    id: playlist.id,
    name: playlist.name,
    trackCount: playlist.trackCount || 0,
  }));

  return { valid: true, playlists };
}

async function getPlaylistPlayableSongs(playlistId, cookie, resultLimit) {
  const response = await fetch(`https://music.163.com/api/v6/playlist/detail?id=${encodeURIComponent(playlistId)}&n=${resultLimit * 2}`, {
    headers: createNeteaseHeaders(cookie),
  });
  const data = await response.json();
  const tracks = data?.playlist?.tracks || [];
  const songs = await filterPlayableSongs(tracks.map(mapNeteaseSong), resultLimit, cookie);
  return songs;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function createDefaultPlaylists() {
  return [
    { id: 'favorites', name: 'Favorites', songs: [] },
    { id: 'visual-set', name: 'Visual Set', songs: [] },
  ];
}

function normalizePlaylists(value) {
  if (!Array.isArray(value) || value.length === 0) return createDefaultPlaylists();
  return value.map((playlist) => ({
    id: String(playlist.id || `playlist-${Date.now()}`),
    name: String(playlist.name || 'Playlist'),
    songs: Array.isArray(playlist.songs) ? playlist.songs : [],
  }));
}

async function readPlaylistsFile() {
  try {
    const raw = await fs.readFile(playlistsPath, 'utf8');
    return normalizePlaylists(JSON.parse(raw));
  } catch (error) {
    return createDefaultPlaylists();
  }
}

async function writePlaylistsFile(playlists) {
  await fs.mkdir(dataDir, { recursive: true });
  const normalized = normalizePlaylists(playlists);
  await fs.writeFile(playlistsPath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

app.get('/api/playlists', async (_req, res) => {
  res.json({ playlists: await readPlaylistsFile() });
});

app.put('/api/playlists', async (req, res) => {
  try {
    const playlists = await writePlaylistsFile(req.body?.playlists);
    res.json({ playlists });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save playlists' });
  }
});

app.get('/api/netease/cookie', async (_req, res) => {
  try {
    const account = await getNeteaseAccount(browserNeteaseCookie);
    res.json({
      hasCookie: Boolean(browserNeteaseCookie),
      valid: account.valid,
      userId: account.userId,
      nickname: account.nickname,
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to check Netease cookie' });
  }
});

app.put('/api/netease/cookie', async (req, res) => {
  try {
    browserNeteaseCookie = normalizeNeteaseCookie(req.body?.cookie);
    playableUrlCache.clear();
    searchCache.clear();
    const account = await getNeteaseAccount(browserNeteaseCookie);
    res.json({ hasCookie: Boolean(browserNeteaseCookie), valid: account.valid, userId: account.userId, nickname: account.nickname });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save Netease cookie' });
  }
});

app.get('/api/netease/search', async (req, res) => {
  try {
    const keywords = String(req.query.keywords || '').trim();
    const requestedLimit = Number(req.query.limit || '30');
    const cookie = readNeteaseCookie(req);
    const hasCookie = Boolean(normalizeNeteaseCookie(cookie));
    const resultLimit = hasCookie
      ? (Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 40)) : 30)
      : (Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 20)) : 12);
    const includeDebug = String(req.query.debug || '') === '1';

    if (!keywords) {
      res.status(400).json({ error: 'Missing keywords' });
      return;
    }

    const searchMode = hasCookie ? `cookie::${normalizeNeteaseCookie(cookie)}` : 'anonymous-baseline';
    const cacheKey = `${keywords.toLowerCase()}::${resultLimit}::${searchMode}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({ ...cached.payload, cached: true });
      return;
    }

    const searchResult = hasCookie
      ? await fetchNeteaseSearchSongs(keywords, resultLimit, cookie)
      : { songs: await fetchAnonymousNeteaseSearchSongs(keywords, resultLimit), debug: { mode: 'anonymous-github' } };
    const rawSongs = searchResult.songs.map(mapNeteaseSong);
    const songs = await filterPlayableSongs(rawSongs, resultLimit, cookie);
    const payload = { songs, rawCount: rawSongs.length, filteredCount: songs.length };
    if (rawSongs.length > 0 || songs.length > 0) {
      searchCache.set(cacheKey, { payload, expiresAt: Date.now() + searchCacheTtl });
    }

    res.json(includeDebug ? { ...payload, debug: searchResult.debug } : payload);
  } catch (error) {
    res.status(500).json({ error: 'Netease search failed' });
  }
});

app.get('/api/netease/liked', async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || '50');
    const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 50;
    const cookie = readNeteaseCookie(req);
    const userPlaylists = await getUserPlaylists(cookie);

    if (!userPlaylists.valid || userPlaylists.playlists.length === 0) {
      res.status(401).json({ error: 'Netease cookie is invalid or expired', songs: [] });
      return;
    }

    const likedPlaylist = userPlaylists.playlists[0];
    const songs = await getPlaylistPlayableSongs(String(likedPlaylist.id), cookie, resultLimit);
    res.json({ songs, playlist: likedPlaylist });
  } catch (error) {
    res.status(500).json({ error: 'Netease liked songs failed' });
  }
});

app.get('/api/netease/playlists', async (req, res) => {
  try {
    const cookie = readNeteaseCookie(req);
    const userPlaylists = await getUserPlaylists(cookie);

    if (!userPlaylists.valid) {
      res.status(401).json({ error: 'Netease cookie is invalid or expired', playlists: [] });
      return;
    }

    res.json({ playlists: userPlaylists.playlists.slice(1) });
  } catch (error) {
    res.status(500).json({ error: 'Netease playlists failed' });
  }
});

app.get('/api/netease/playlist', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const requestedLimit = Number(req.query.limit || '50');
    const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 50;
    const cookie = readNeteaseCookie(req);

    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const account = await getNeteaseAccount(cookie);
    if (!account.valid) {
      res.status(401).json({ error: 'Netease cookie is invalid or expired', songs: [] });
      return;
    }

    const songs = await getPlaylistPlayableSongs(id, cookie, resultLimit);
    res.json({ songs });
  } catch (error) {
    res.status(500).json({ error: 'Netease playlist failed' });
  }
});

app.get('/api/netease/daily-recommend', async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || '30');
    const resultLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 50)) : 30;
    const cookie = readNeteaseCookie(req);
    const result = await getDailyRecommendSongs(cookie, resultLimit);

    if (!result.valid) {
      res.status(401).json({ error: 'Netease cookie is invalid or expired', songs: [] });
      return;
    }

    res.json({ songs: result.songs });
  } catch (error) {
    res.status(500).json({ error: 'Netease daily recommend failed' });
  }
});

app.get('/api/netease/lyric', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const cookie = readNeteaseCookie(req);
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const response = await fetch(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=-1&kv=-1&tv=-1`, {
      headers: createNeteaseHeaders(cookie),
    });
    const data = await response.json();
    res.json({
      lyric: data?.lrc?.lyric || '',
      translatedLyric: data?.tlyric?.lyric || '',
    });
  } catch (error) {
    res.status(500).json({ error: 'Netease lyric failed' });
  }
});

app.get('/api/netease/url', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const cookie = readNeteaseCookie(req);
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    res.json({ url: await getNeteasePlayableUrl(id, cookie) });
  } catch (error) {
    res.status(500).json({ error: 'Netease url failed' });
  }
});

app.get('/api/netease/audio', async (req, res) => {
  try {
    const id = String(req.query.id || '');
    const cookie = readNeteaseCookie(req);
    if (!id) {
      res.status(400).json({ error: 'Missing id' });
      return;
    }

    const playableUrl = await getNeteasePlayableUrl(id, cookie);
    if (!playableUrl) {
      res.status(404).json({ error: 'No playable url for this song' });
      return;
    }

    const headers = createNeteaseHeaders(cookie);
    if (req.headers.range) headers.Range = req.headers.range;

    const audioResponse = await fetch(playableUrl, { headers });
    res.status(audioResponse.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
      const value = audioResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
    if (audioResponse.body) {
      const reader = audioResponse.body.getReader();
      const pump = async () => {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value), pump);
      };
      pump();
    } else {
      res.end();
    }
  } catch (error) {
    res.status(500).json({ error: 'Netease audio proxy failed' });
  }
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Sonic Topography is running at http://127.0.0.1:${port}`);
});


