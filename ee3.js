// Settings start
const USERNAME = "YOUR_USERNAME_HERE";
const PASSWORD = "YOUR_PASSWORD_HERE";
// Settings end

const BASE_URL = "https://ee3.me";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let _sessionCookie = "";
let _loginPromise = null;

async function ensureSession() {
    if (_sessionCookie) return;
    if (_loginPromise) return _loginPromise;
    _loginPromise = (async () => {
        try {
            const body = `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`;
            // redirect=false so we capture the 303 Set-Cookie before following
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
            // On success SvelteKit returns 303 with Set-Cookie: session=VALUE; Path=/; ...
            const headers = res.headers || {};
            const setCookie = headers["set-cookie"] || headers["Set-Cookie"] || "";
            const match = setCookie.match(/session=([^;]+)/);
            if (match) {
                _sessionCookie = match[1];
            } else {
                // Login failed — body will have the failure message
                const text = await res.text();
                throw new Error("Login failed: " + text);
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

async function searchResults(keyword) {
    try {
        await ensureSession();
        const url = `${BASE_URL}/api/movies?title=${encodeURIComponent(keyword)}&sort=-tmdb_data.vote_average&page=1&perPage=20`;
        const res = await fetchv2(url, ee3Headers());
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

function parseSvelteKitData(html) {
    try {
        const match = html.match(/kit\.start\(app,\s*element,\s*(\{[\s\S]*?\})\s*\)/);
        if (!match) return null;
        // kit.start uses a non-standard JSON-like object; extract data array
        // The structure is {..., data: [...], ...}
        // Use a regex to find the JSON blob inside kit.start safely
        const raw = match[1];
        // Find data array position
        const dataMatch = raw.match(/"data"\s*:\s*(\[[\s\S]*?\])\s*,\s*"form"/);
        if (!dataMatch) {
            // Try broader match
            const dataMatch2 = raw.match(/"data"\s*:\s*(\[[\s\S]*)/);
            if (dataMatch2) {
                try { return JSON.parse(dataMatch2[1].replace(/,\s*"nodes"[\s\S]*$/, "]")); } catch(e) {}
            }
            return null;
        }
        return JSON.parse(dataMatch[1]);
    } catch (e) {
        return null;
    }
}

async function getMovieData(url) {
    const res = await fetchv2(url, {
        "User-Agent": UA,
        "Accept": "text/html",
        "Cookie": `session=${_sessionCookie}`
    });
    const html = await res.text();

    // Extract kit.start JSON blob
    const startMatch = html.match(/kit\.start\(app,\s*element,\s*(\{[\s\S]+?\})\s*\)\s*;?\s*<\/script>/);
    if (!startMatch) return null;

    try {
        const blob = JSON.parse(startMatch[1]);
        const dataArr = blob.data;
        if (Array.isArray(dataArr)) {
            for (const node of dataArr) {
                if (node && node.movie) return node.movie;
                if (node && node.data && node.data.movie) return node.data.movie;
            }
        }
    } catch (e) {}

    // Fallback: regex-find tmdb block from the raw JSON string in page
    try {
        const tmdbMatch = html.match(/"tmdb_data"\s*:\s*(\{[^}]{50,}\})/);
        if (tmdbMatch) return { tmdb_data: JSON.parse(tmdbMatch[1]) };
    } catch (e) {}
    return null;
}

async function extractDetails(url) {
    try {
        await ensureSession();
        const movie = await getMovieData(url);
        const tmdb = (movie && movie.tmdb_data) || {};
        const description = tmdb.overview || "";
        const airdate = tmdb.release_date ? tmdb.release_date.substring(0, 4) : "";
        const aliases = tmdb.original_title && tmdb.original_title !== tmdb.title ? tmdb.original_title : "";
        return JSON.stringify([{ description, aliases, airdate }]);
    } catch (e) {
        return JSON.stringify([{ description: "", aliases: "", airdate: "" }]);
    }
}

async function extractEpisodes(url) {
    // ee3.me is movies-only
    return JSON.stringify([{ number: 1, href: url }]);
}

async function extractStreamUrl(url) {
    try {
        await ensureSession();
        // Get movie page to find imdb_id and movie id
        const res = await fetchv2(url, {
            "User-Agent": UA,
            "Accept": "text/html",
            "Cookie": `session=${_sessionCookie}`
        });
        const html = await res.text();

        // Extract movie id from URL
        const movieId = url.split("/movies/")[1]?.split("/")[0] || "";

        // Find imdb_id from page HTML
        let imdbId = null;
        const imdbMatch = html.match(/"imdb_id"\s*:\s*"(tt\d+)"/);
        if (imdbMatch) imdbId = imdbMatch[1];

        if (!imdbId) {
            // Try fetching movie from search API using title parsed from page
            const titleMatch = html.match(/<title>([^<|]+)/i);
            if (titleMatch) {
                const title = titleMatch[1].trim();
                const searchRes = await fetchv2(
                    `${BASE_URL}/api/movies?title=${encodeURIComponent(title)}&page=1&perPage=5`,
                    ee3Headers()
                );
                const searchJson = JSON.parse(await searchRes.text());
                const found = (searchJson.items || []).find(i => i.id === movieId);
                if (found) imdbId = found.tmdb_data?.imdb_id;
            }
        }

        if (!imdbId) return JSON.stringify({ stream: null });

        // Step 1: GET /api/torrent/{imdbId} → torrentio URL
        const torrentRes = await fetchv2(`${BASE_URL}/api/torrent/${imdbId}`, ee3Headers());
        const torrentData = JSON.parse(await torrentRes.text());
        const torrentioUrl = torrentData.torrentioUrl;
        if (!torrentioUrl) return JSON.stringify({ stream: null });

        // Step 2: GET torrentio streams
        const streamsRes = await fetchv2(torrentioUrl, { "User-Agent": UA, "Accept": "application/json" });
        const streamsData = JSON.parse(await streamsRes.text());
        const streams = streamsData.streams || [];
        if (streams.length === 0) return JSON.stringify({ stream: null });

        // Pick best stream: prefer 1080p, fallback to first
        const preferred = streams.find(s => s.name && s.name.includes("1080p")) || streams[0];
        const infoHash = preferred.infoHash;
        const fileIdx = preferred.fileIdx !== undefined ? preferred.fileIdx : 0;
        const filename = (preferred.behaviorHints && preferred.behaviorHints.filename) || "";

        // Step 3: POST /api/torrent/{imdbId} to resolve download URL
        const postRes = await fetchv2(
            `${BASE_URL}/api/torrent/${imdbId}`,
            ee3Headers({ "Content-Type": "application/json" }),
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
