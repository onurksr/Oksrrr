'use strict';
const crypto = require('crypto');

// Render -> Environment -> TMDB_API_KEY. Both v3 API keys and v4 read tokens work.
const TMDB_KEY = String(process.env.TMDB_API_KEY || process.env.TMDB_READ_ACCESS_TOKEN || '').trim();
const hasTmdb = () => Boolean(TMDB_KEY);
const tmdbHeaders = TMDB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${TMDB_KEY}` } : {};

const fold = s => String(s || '').toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const cache = new Map();
const getC = k => { const h = cache.get(k); return h && h.exp > Date.now() ? h.v : undefined; };
const setC = (k, v, ms) => cache.set(k, { v, exp: Date.now() + ms });
const shuffle = a => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };

const stats = { songRequests: 0, songSuccess: 0, filmRequests: 0, filmSuccess: 0, filmNoFrames: 0, lastFilmError: '' };
async function getJson(url, headers = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10000);
  try {
    const r = await fetch(url, { signal: c.signal, headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

function titleScore(candidate, wanted) {
  const a = fold(candidate), b = fold(wanted);
  if (!a || !b) return 0;
  if (a === b) return 10;
  if (a.includes(b) || b.includes(a)) return 7;
  const aa = new Set(a.split(' ')), bb = b.split(' ');
  const common = bb.filter(w => aa.has(w)).length;
  return common / Math.max(1, bb.length) * 5;
}
function artistScore(candidate, wanted) {
  const a = fold(candidate), b = fold(wanted);
  if (!a || !b) return 0;
  if (a === b) return 7;
  if (a.includes(b) || b.includes(a)) return 5;
  const first = b.split(' ')[0];
  return first.length > 3 && a.split(' ').includes(first) ? 2 : 0;
}

async function resolveSong(item) {
  stats.songRequests++;
  const key = 's:' + item.id;
  const hit = getC(key);
  if (hit !== undefined) { if (hit) stats.songSuccess++; return hit; }
  let url = null;
  const queries = [item.artist + ' ' + item.title, item.title + ' ' + item.artist, item.title];
  for (const country of ['TR', 'US']) {
    for (const term of queries) {
      try {
        const j = await getJson('https://itunes.apple.com/search?' + new URLSearchParams({ media: 'music', entity: 'song', limit: '25', country, term }));
        const ranked = (j.results || []).filter(x => x.previewUrl).map(x => ({
          x,
          score: titleScore(x.trackName, item.title) * 1.25 + artistScore(x.artistName, item.artist)
        })).sort((a, b) => b.score - a.score);
        if (ranked[0] && ranked[0].score >= 9) { url = ranked[0].x.previewUrl; break; }
      } catch (e) { /* Try the next query/provider. */ }
    }
    if (url) break;
  }
  if (!url) {
    for (const term of [`track:"${item.title}" artist:"${item.artist}"`, `${item.title} ${item.artist}`]) {
      try {
        const j = await getJson('https://api.deezer.com/search?' + new URLSearchParams({ limit: '25', q: term }));
        const ranked = (j.data || []).filter(x => x.preview).map(x => ({
          x,
          score: titleScore(x.title, item.title) * 1.25 + artistScore(x.artist && x.artist.name, item.artist)
        })).sort((a, b) => b.score - a.score);
        if (ranked[0] && ranked[0].score >= 9) { url = ranked[0].x.preview; break; }
      } catch (e) { /* Continue; the catalog will skip unavailable previews. */ }
    }
  }
  if (url) stats.songSuccess++;
  setC(key, url, url ? 6 * 3600e3 : 90e3);
  return url;
}

function tmdbUrl(path, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  if (!tmdbHeaders.Authorization) u.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

function filmTitleTokens(title) {
  return fold(title).split(' ').filter(w => w.length > 1 && !['the', 'a', 'an', 'of', 'and', 'to'].includes(w));
}

function commonsFilenameMatches(filename, title) {
  const name = fold(filename);
  const tokens = filmTitleTokens(title);
  if (!tokens.length) return false;
  // Require every distinctive word from the film title. This prevents a generic
  // Commons search result (or another film with one shared word) being shown.
  if (!tokens.every(token => name.split(' ').includes(token))) return false;
  if (/\b(poster|cover|logo|soundtrack|book|dvd|bluray|fan.?art|wallpaper|banner|collage)\b/i.test(name)) return false;
  // A single-word title needs an explicit scene/still marker to avoid accepting
  // unrelated photographs whose filename merely contains that word.
  if (tokens.length === 1 && !/\b(scene|still|screenshot|frame|film|movie|capture)\b/i.test(name)) return false;
  return true;
}

async function resolveCommonsFilm(item) {
  const title = item.en || item.title;
  if (!title) return [];
  const terms = [`"${title}" film scene`, `"${title}" movie still`, `"${title}" screenshot`];
  const collected = [];
  for (const term of terms) {
    try {
      const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({
        action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6',
        gsrsearch: term, gsrlimit: '50', prop: 'imageinfo',
        iiprop: 'url|size|mime', iiurlwidth: '1280'
      });
      const data = await getJson(url, { 'User-Agent': 'PartiOdasi/1.0 (film quiz)' });
      const pages = Object.values(data.query?.pages || []);
      for (const page of pages) {
        const name = String(page.title || '').replace(/^File:/i, '');
        const info = page.imageinfo?.[0] || {};
        const imageUrl = info.thumburl || info.url;
        if (!commonsFilenameMatches(name, title)) continue;
        if (!imageUrl || !/^https:\/\//i.test(imageUrl)) continue;
        if (info.mime && !info.mime.startsWith('image/')) continue;
        if (info.width && info.width < 700) continue;
        if (info.height && info.height < 350) continue;
        const aspect = info.width && info.height ? info.width / info.height : 0;
        if (aspect && aspect < 1.35) continue;
        collected.push({ url: imageUrl, score: titleScore(name, title) + (/\b(scene|still|screenshot|frame|capture)\b/i.test(name) ? 3 : 0), name });
      }
    } catch (e) {
      stats.lastFilmError = String(e && e.message || 'Wikimedia araması başarısız').slice(0, 80);
    }
  }
  const unique = [...new Map(collected.map(x => [x.url, x])).values()]
    .sort((a, b) => b.score - a.score);
  return unique.slice(0, 5).map(x => x.url);
}

async function resolveFilm(item, n = 5, usedSceneUrls = new Set()) {
  stats.filmRequests++;
  const key = 'f:' + item.id;
  let pool = getC(key);

  if (!pool) {
    let rawPool = Array.isArray(item.images)
      ? item.images.filter(u => typeof u === 'string' && /^https:\/\//i.test(u))
      : [];
    let movieId = item.tmdb || null;
    let searchError = '';

    if (hasTmdb() && !movieId) {
      const queries = [...new Set([item.en, item.title].filter(Boolean))];
      const candidates = [];
      for (const query of queries) {
        try {
          let data = await getJson(tmdbUrl('/search/movie', { query, year: item.year, include_adult: false, language: 'en-US' }), tmdbHeaders);
          if (!data.results?.length) {
            data = await getJson(tmdbUrl('/search/movie', { query, include_adult: false, language: 'en-US' }), tmdbHeaders);
          }
          candidates.push(...(data.results || []));
        } catch (e) {
          searchError = String(e && e.message || 'TMDB araması başarısız');
        }
      }
      const wanted = item.en || item.title;
      const score = x => Math.max(titleScore(x.title, wanted), titleScore(x.original_title, wanted))
        + (item.year && String(x.release_date || '').startsWith(String(item.year)) ? 4 : 0);
      candidates.sort((a, b) => score(b) - score(a));
      // Never silently use the first loosely-related TMDB result. A wrong movie
      // ID produces convincing-looking but incorrect scene images.
      const best = candidates[0];
      movieId = best && score(best) >= (item.year ? 11 : 9) ? best.id : null;
      const searchBackdrop = movieId ? best.backdrop_path : null;
      if (searchBackdrop) rawPool.push('https://image.tmdb.org/t/p/w1280' + searchBackdrop);
    }

    if (hasTmdb() && movieId) {
      try {
        const images = await getJson(tmdbUrl(`/movie/${movieId}/images`), tmdbHeaders);
        const backdrops = (images.backdrops || []).filter(x =>
          x.file_path &&
          x.width >= 900 &&
          x.height >= 400 &&
          (x.aspect_ratio || x.width / Math.max(1, x.height)) >= 1.50
        );
        backdrops.sort((a, b) => {
          const textless = x => (x.iso_639_1 === null ? 2 : ['en', 'tr'].includes(x.iso_639_1) ? 1 : 0);
          return textless(b) - textless(a)
            || (b.vote_count || 0) - (a.vote_count || 0)
            || (b.width || 0) - (a.width || 0);
        });
        rawPool.push(...backdrops.map(x => 'https://image.tmdb.org/t/p/w1280' + x.file_path));
      } catch (e) {
        stats.lastFilmError = String(e && e.message || 'TMDB görsel isteği başarısız').slice(0, 100);
      }

      if (!rawPool.length) {
        try {
          const details = await getJson(tmdbUrl(`/movie/${movieId}`, { language: 'en-US' }), tmdbHeaders);
          if (details.backdrop_path) rawPool.push('https://image.tmdb.org/t/p/w1280' + details.backdrop_path);
        } catch (e) {
          stats.lastFilmError = String(e && e.message || 'TMDB film detayı alınamadı').slice(0, 100);
        }
      }
    } else if (hasTmdb() && searchError) {
      stats.lastFilmError = searchError.slice(0, 100);
    }

    rawPool = [...new Set(rawPool)].filter(u => /^https:\/\//i.test(u));
    if (rawPool.length < n) {
      const commons = await resolveCommonsFilm(item);
      rawPool = [...new Set([...rawPool, ...commons])];
    }

    pool = [...new Set(rawPool)].filter(u => /^https:\/\//i.test(u));
    if (pool.length) setC(key, pool, 12 * 3600e3);
  }

  if (!pool || !pool.length) {
    if (!stats.lastFilmError) {
      stats.lastFilmError = hasTmdb() ? 'TMDB film araması sahne görseli döndürmedi' : 'TMDB_API_KEY tanımlı değil';
    }
    stats.filmNoFrames++;
    return null;
  }

  const unseen = pool.filter(u => !usedSceneUrls.has(u));
  const candidatePool = unseen.length >= Math.min(n, pool.length) ? unseen : [...unseen, ...shuffle(pool)];
  const uniquePool = [...new Set(candidatePool)];

  const len = uniquePool.length;
  const startSlice = uniquePool.slice(0, Math.floor(len * 0.25));
  const midSlice = uniquePool.slice(Math.floor(len * 0.25), Math.max(1, Math.ceil(len * 0.75)));
  const endSlice = uniquePool.slice(Math.ceil(len * 0.75));

  const balanced = [
    ...shuffle(midSlice),
    ...shuffle(startSlice),
    ...shuffle(endSlice)
  ];

  const selected = [...new Set(balanced)].slice(0, Math.min(n, balanced.length));
  selected.forEach(u => usedSceneUrls.add(u));
  stats.filmSuccess++;
  stats.lastFilmError = '';
  return selected;
}

async function resolveVisual(item) {
  const key = 'v:' + item.id;
  const hit = getC(key);
  if (hit !== undefined) return hit;
  let url = item.image || null;
  // Club quizzes should show an actual crest, not a generic team photograph.
  if (!url && item.id && item.id.startsWith('club-')) {
    for (const term of [`${item.answer} football club crest`, `${item.answer} football club logo`]) {
      try {
        const api = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ action:'query', format:'json', origin:'*', generator:'search', gsrnamespace:'6', gsrsearch:term, gsrlimit:'30', prop:'imageinfo', iiprop:'url', iiurlwidth:'800' });
        const data = await getJson(api, { 'User-Agent': 'PartiOdasi/1.0' });
        const pages = Object.values(data.query?.pages || []).map(page => {
          const title = String(page.title || '').replace(/^File:/i, '');
          const lower = title.toLocaleLowerCase('en');
          const score = titleScore(title, item.answer) + (/crest|logo|badge|emblem|coat of arms/i.test(lower) ? 5 : 0)
            - (/stadium|player|match|team photo|kit|shirt|flag/i.test(lower) ? 6 : 0);
          return { score, url: page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url };
        }).filter(x => x.url && /^https:\/\//i.test(x.url) && x.score >= 3).sort((a,b)=>b.score-a.score);
        if (pages[0]) { url = pages[0].url; break; }
      } catch (e) { stats.lastFilmError = String(e && e.message || 'Kulüp arması bulunamadı').slice(0, 100); }
    }
  }
  if (!url && item.page) {
    try {
      const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(item.page.replace(/ /g, '_')), { 'User-Agent': 'PartiOdasi/1.0' });
      url = j.thumbnail?.source || j.originalimage?.source || null;
    } catch (e) { stats.lastFilmError = String(e && e.message || 'Wikipedia görseli alınamadı').slice(0, 100); }
    if (!url) {
      try {
        const api = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ action:'query', format:'json', origin:'*', generator:'search', gsrnamespace:'6', gsrsearch:item.page, gsrlimit:'15', prop:'imageinfo', iiprop:'url', iiurlwidth:'800' });
        const data = await getJson(api, { 'User-Agent': 'PartiOdasi/1.0' });
        const pages = Object.values(data.query?.pages || {}).map(page => ({
          score: titleScore(page.title, item.page) - (/logo|flag|coat of arms|poster|book cover/i.test(page.title || '') ? 8 : 0),
          url: page.imageinfo?.[0]?.thumburl || page.imageinfo?.[0]?.url
        })).filter(x => x.url && /^https:\/\//i.test(x.url) && x.score >= 1).sort((a,b)=>b.score-a.score);
        url = pages[0]?.url || null;
      } catch (e) { stats.lastFilmError = String(e && e.message || 'Commons görsel araması başarısız').slice(0, 100); }
    }
  }
  if (url && /^https:\/\//i.test(url)) { setC(key, url, 24 * 3600e3); return url; }
  setC(key, null, 60e3);
  return null;
}

const PXUA = { 'User-Agent': 'PartiOdasi/1.0 (party game)' };
const PX_W = [20, 40, 60, 120];
const px = { ok: 0, fail: 0, checked: 0, running: false };
async function imgOk(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 7000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: PXUA });
    const ok = r.ok && /^image\//.test(r.headers.get('content-type') || '');
    await r.arrayBuffer().catch(() => {});
    return ok;
  } catch (e) { return false; } finally { clearTimeout(t); }
}
async function resolvePixel(item) {
  const key = 'p:' + item.title, hit = getC(key);
  if (hit !== undefined) return hit;
  let res = null;
  try {
    const j = await getJson('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(item.title.replace(/ /g, '_')), PXUA);
    const src = j.thumbnail && j.thumbnail.source;
    if (src && src.includes('/wikipedia/commons/') && /\/\d+px-/.test(src) && !/\.svg/i.test(src)) {
      const small = PX_W.map(w => src.replace(/\/\d+px-/, '/' + w + 'px-'));
      const oks = await Promise.all([...small, src].map(imgOk));
      if (oks.every(Boolean)) res = [...small, src];
      else if (oks[4]) res = [src, src, src, src, src];
    }
  } catch (e) { res = null; }
  setC(key, res, res ? 6 * 3600e3 : 600e3);
  return res;
}
async function pixelCheck(items) {
  if (px.running) return;
  px.running = true; px.ok = 0; px.fail = 0; px.checked = 0;
  const q = [...items];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length) { const r = await resolvePixel(q.shift()); px[r ? 'ok' : 'fail']++; px.checked++; }
  }));
  px.running = false;
}
const pixelStats = () => ({ ...px });
const mediaStatus = () => ({ tmdbConfigured: hasTmdb(), ...stats, pixel: pixelStats() });

module.exports = { fold, hasTmdb, resolveSong, resolveFilm, resolveVisual, resolvePixel, pixelCheck, pixelStats, mediaStatus };
