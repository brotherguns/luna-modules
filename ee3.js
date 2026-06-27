// Settings start
const USERNAME = "YOUR_USERNAME_HERE"; // ee3.me username
const PASSWORD = "YOUR_PASSWORD_HERE"; // ee3.me password
// Settings end

const BASE_URL = "https://ee3.me";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let _sessionCookie = "";
let _loginPromise = null;
// Cache imdb_id and movieId keyed by movie page URL — populated in extractDetails,
// consumed in extractStreamUrl to avoid re-fetching the HTML page
const _movieCache = {};

async function ensureSession(force) {
    if (_sessionCookie && !force) return;
    if (force) _sessionCookie = "";
    if (_loginPromise) return _loginPromise;
    _loginPromise = (async () => {
        try {
            const body = `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
            const res = await fetchv2(
                `${BASE_URL}/login`,
                {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": BASE_URL,
                    "Referer": `${BASE_URL}/login`
                },
                "POST",
                body,
                false
            );
            const headers = res.headers || {};
            const setCookie = headers["set-cookie"] || headers["Set-Cookie"] || "";
            const match = setCookie.match(/session=([^;]+)/);
            if (match) {
                _sessionCookie = match[1];
            } else {
                throw new Error("Login failed: " + (await res.text()));
            }
        } finally {
            _loginPromise = null;
        }
    })();
    return _loginPromise;
}

function ee3Headers(extra) {
    const h = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Cookie": `session=${_sessionCookie}`
    };
    if (extra) Object.assign(h, extra);
    return h;
}

// Authenticated fetch: ensures a session, re-logins once on a 401/403 auth bounce
// (stale module-level cookie), and rejects non-2xx so JSON.parse only runs on a good body.
async function ee3Fetch(url, extra, method, body) {
    await ensureSession();
    let res = await fetchv2(url, ee3Headers(extra), method, body);
    if (res.status === 401 || res.status === 403) {
        await ensureSession(true);
        res = await fetchv2(url, ee3Headers(extra), method, body);
    }
    if (res.status < 200 || res.status >= 300) {
        throw new Error("ee3 HTTP " + res.status);
    }
    return res;
}

async function fetchMoviePage(url) {
    const res = await fetchv2(url, {
        "User-Agent": UA,
        "Accept": "text/html",
        "Cookie": `session=${_sessionCookie}`
    });
    const html = await res.text();
    const movieId = url.split("/movies/")[1]?.split("/")[0] || "";
    const imdbMatch = html.match(/"imdb_id"\s*:\s*"(tt\d+)"/);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    // Pull description/year from inline SSR data. A [^}] regex truncates at the
    // first nested brace, so scan for a brace-balanced object (string/escape aware).
    let tmdb = {};
    try {
        const key = '"tmdb_data"';
        const ki = html.indexOf(key);
        if (ki !== -1) {
            const start = html.indexOf('{', ki + key.length);
            if (start !== -1) {
                let depth = 0, inStr = false, esc = false, end = -1;
                for (let i = start; i < html.length; i++) {
                    const c = html[i];
                    if (inStr) {
                        if (esc) esc = false;
                        else if (c === '\\') esc = true;
                        else if (c === '"') inStr = false;
                    } else if (c === '"') inStr = true;
                    else if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end !== -1) tmdb = JSON.parse(html.slice(start, end + 1));
            }
        }
    } catch (e) {}

    return { movieId, imdbId, tmdb };
}

async function searchResults(keyword) {
    try {
        const url = `${BASE_URL}/api/movies?title=${encodeURIComponent(keyword)}&sort=-tmdb_data.vote_average&page=1&perPage=20`;
        const res = await ee3Fetch(url);
        const json = JSON.parse(await res.text());
        const items = json.items || [];
        return JSON.stringify(items.map(item => {
            const tmdb = item.tmdb_data || {};
            const poster = tmdb.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : "";
            return {
                title: tmdb.title || tmdb.original_title || item.id || "",
                image: poster,
                href: `${BASE_URL}/movies/${item.id}`
            };
        }).filter(i => i.title));
    } catch (e) {
        return JSON.stringify([]);
    }
}

async function extractDetails(url) {
    try {
        await ensureSession();
        const { movieId, imdbId, tmdb } = await fetchMoviePage(url);
        // Populate cache so extractStreamUrl can skip this fetch
        if (movieId) _movieCache[url] = { movieId, imdbId };
        const description = tmdb.overview || "";
        const airdate = tmdb.release_date ? tmdb.release_date.substring(0, 4) : "";
        const aliases = tmdb.original_title && tmdb.original_title !== tmdb.title ? tmdb.original_title : "";
        return JSON.stringify([{ description, aliases, airdate }]);
    } catch (e) {
        return JSON.stringify([{ description: "", aliases: "", airdate: "" }]);
    }
}

async function extractEpisodes(url) {
    return JSON.stringify([{ number: 1, href: url }]);
}

async function extractStreamUrl(url) {
    try {
        // Ensure session and get movie identifiers in parallel when possible
        const sessionPromise = ensureSession();

        // Use cached imdb_id/movieId from extractDetails if available — skips HTML fetch
        let cached = _movieCache[url];
        if (!cached) {
            await sessionPromise;
            const data = await fetchMoviePage(url);
            cached = { movieId: data.movieId, imdbId: data.imdbId };
            if (data.movieId) _movieCache[url] = cached;
        } else {
            await sessionPromise;
        }

        const { movieId, imdbId } = cached;
        if (!imdbId) return JSON.stringify({ stream: null });

        // Step 1: GET torrentio URL from ee3
        const torrentRes = await ee3Fetch(`${BASE_URL}/api/torrent/${imdbId}`);
        const torrentData = JSON.parse(await torrentRes.text());
        const torrentioUrl = torrentData.torrentioUrl;
        if (!torrentioUrl) return JSON.stringify({ stream: null });

        // Step 2: GET streams from torrentio
        const streamsRes = await fetchv2(torrentioUrl, { "User-Agent": UA, "Accept": "application/json" });
        const streamsData = JSON.parse(await streamsRes.text());
        const streams = streamsData.streams || [];
        if (!streams.length) return JSON.stringify({ stream: null });

        // Prefer 1080p, fallback to first
        const preferred = streams.find(s => s.name && s.name.includes("1080p")) || streams[0];
        const infoHash = preferred.infoHash;
        const fileIdx = preferred.fileIdx !== undefined ? preferred.fileIdx : 0;
        const filename = (preferred.behaviorHints && preferred.behaviorHints.filename) || "";

        // Step 3: POST to resolve proxy download URL
        const postRes = await ee3Fetch(
            `${BASE_URL}/api/torrent/${imdbId}`,
            { "Content-Type": "application/json" },
            "POST",
            JSON.stringify({ infoHash, fileIdx, movieId, filename })
        );
        const postData = JSON.parse(await postRes.text());
        const downloadUrl = postData.downloadUrl;
        if (!downloadUrl) return JSON.stringify({ stream: null });

        const fullUrl = downloadUrl.startsWith("http") ? downloadUrl : `${BASE_URL}${downloadUrl}`;
        return JSON.stringify({ stream: fullUrl });
    } catch (e) {
        return JSON.stringify({ stream: null });
    }
}
