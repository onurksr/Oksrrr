const assert = require('node:assert/strict');
process.env.TMDB_API_KEY = 'test-key';
const media = require('../data/media');

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async input => {
    const url = String(input);
    if (url.includes('/search/movie')) {
      return { ok: true, json: async () => ({ results: [
        { id: 999, title: 'A Completely Different Film', original_title: 'A Completely Different Film', release_date: '2020-01-01', backdrop_path: '/wrong-film.jpg' }
      ] }) };
    }
    if (url.includes('commons.wikimedia.org/w/api.php')) {
      return { ok: true, json: async () => ({ query: { pages: {
        1: { title: 'File:Film Festival Poster.jpg', imageinfo: [{ mime: 'image/jpeg', width: 1600, height: 900, thumburl: 'https://upload.wikimedia.org/wrong-poster.jpg' }] },
        2: { title: 'File:Another Movie - Scene Still.jpg', imageinfo: [{ mime: 'image/jpeg', width: 1600, height: 900, thumburl: 'https://upload.wikimedia.org/wrong-scene.jpg' }] }
      } } }) };
    }
    throw new Error('Unexpected request: ' + url);
  };
  try {
    const frames = await media.resolveFilm({
      id: 'relevance-check', title: 'The Matrix', en: 'The Matrix', year: 1999
    });
    assert.equal(frames, null, 'A different movie or unrelated Commons image must never be shown');
    console.log('Film relevance tests passed: unrelated movie images are rejected.');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
