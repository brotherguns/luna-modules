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
            // Luna's fetchv2 exposes response headers from HTTPURLResponse.allHeaderFields,
            // lowercase-keyed over HTTP/2 — the URLSession cookie store consuming Set-Cookie
            // does not strip it from that dictionary, so reading it here is reliable.
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
    // Authed HTML fetch. Do NOT follow redirects: an expired/invalid session
    // 303-redirects to /login, and following it would return login HTML (no
    // imdb_id/tmdb_data), silently breaking extraction. On a redirect or 401/403,
    // force a re-login once and retry so a stale cookie self-heals.
    await ensureSession();
    // Reuse ee3Headers so the session cookie is sent, but ask for HTML.
    const htmlHeaders = () => ee3Headers({ "Accept": "text/html" });
    let res = await fetchv2(url, htmlHeaders(), "GET", null, false);
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
        await ensureSession(true);
        res = await fetchv2(url, htmlHeaders(), "GET", null, false);
    }
    const html = await res.text();
    const movieId = url.split("/movies/")[1]?.split("/")[0] || "";
    // The SvelteKit page embeds the data as a JS object literal where the key is
    // unquoted: `imdb_id:"tt1375666"`. The old /"imdb_id":"tt..."/ regex required a
    // quoted key and never matched. Match an optionally-quoted key, then the tt id.
    const imdbMatch = html.match(/["']?imdb_id["']?\s*:\s*["'](tt\d+)["']/);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    // The page is a SvelteKit JS object literal (unquoted keys), not JSON, so the
    // detail fields are read individually rather than parsed as one tmdb_data blob.
    const field = (name) => {
        const m = html.match(new RegExp('["\']?' + name + '["\']?\\s*:\\s*["\']((?:[^"\'\\\\]|\\\\.)*)["\']'));
        return m ? m[1].replace(/\\(.)/g, '$1') : "";
    };
    const tmdb = {
        overview: field("overview"),
        release_date: field("release_date"),
        title: field("title"),
        original_title: field("original_title")
    };

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

        // Order candidates: 1080p first, then the rest. Try each in turn so a single
        // torrent that errors or is still being prepared doesn't kill the whole result.
        const candidates = [
            ...streams.filter(s => s.name && s.name.includes("1080p")),
            ...streams.filter(s => !(s.name && s.name.includes("1080p")))
        ];

        for (const c of candidates) {
            try {
                // Step 3: POST to resolve proxy download URL. fileIdx MUST be a string —
                // ee3's resolve endpoint 500s ("Failed to process download") on an integer.
                const fileIdx = c.fileIdx !== undefined ? String(c.fileIdx) : undefined;
                const filename = (c.behaviorHints && c.behaviorHints.filename) || "";
                const postRes = await ee3Fetch(
                    `${BASE_URL}/api/torrent/${imdbId}`,
                    { "Content-Type": "application/json" },
                    "POST",
                    JSON.stringify({ infoHash: c.infoHash, fileIdx, movieId, filename })
                );
                const postData = JSON.parse(await postRes.text());
                const downloadUrl = postData.downloadUrl;
                // A still-preparing torrent returns 200 with a message and no downloadUrl —
                // skip to the next candidate rather than giving up.
                if (!downloadUrl) continue;

                const fullUrl = downloadUrl.startsWith("http") ? downloadUrl : `${BASE_URL}${downloadUrl}`;
                return JSON.stringify({ stream: fullUrl });
            } catch (e) {
                continue;
            }
        }

        return JSON.stringify({ stream: null });
    } catch (e) {
        return JSON.stringify({ stream: null });
    }
}
