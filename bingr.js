// Settings start
const PREFERRED_OTT = "nf"; // Netflix source [nf, pv, hs]
// Settings end

const BINGR_API = "https://api.bingr.live/api";
const FILMU_API = "https://ott.filmu.in";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let _filmToken = null;
let _filmTokenExpiry = 0;

async function getFilmToken() {
    if (_filmToken && Date.now() < _filmTokenExpiry) return _filmToken;
    const res = await fetchv2(`${FILMU_API}/api/v1/token`, { "User-Agent": UA }, "POST", "");
    const data = JSON.parse(await res.text());
    _filmToken = data.token || null;
    _filmTokenExpiry = Date.now() + 2.5 * 60 * 60 * 1000;
    return _filmToken;
}

async function filmFetch(path) {
    const token = await getFilmToken();
    const headers = { "User-Agent": UA };
    if (token) headers["x-api-key"] = token;
    let res = await fetchv2(`${FILMU_API}${path}`, headers);
    if (res.status === 401 || res.status === 403) {
        // Cached token rejected — clear both fields BEFORE re-fetching so the
        // getFilmToken cache guard doesn't hand back the stale token, then retry once.
        _filmToken = null;
        _filmTokenExpiry = 0;
        const fresh = await getFilmToken();
        if (fresh) headers["x-api-key"] = fresh;
        res = await fetchv2(`${FILMU_API}${path}`, headers);
    }
    return JSON.parse(await res.text());
}

async function bingrFetch(path) {
    const res = await fetchv2(`${BINGR_API}${path}`, {
        "User-Agent": UA,
        "Origin": "https://bingr.live",
        "Referer": "https://bingr.live/"
    });
    return JSON.parse(await res.text());
}

async function searchResults(keyword) {
    try {
        const data = await bingrFetch(`/search?q=${encodeURIComponent(keyword)}`);
        const results = (data.results || []).filter(i => i.type === "tv");
        return JSON.stringify(results.map(item => ({
            title: item.title + (item.year ? ` (${item.year})` : ""),
            image: item.poster || "",
            href: `https://bingr.live/watch/tv/${item.id}`
        })));
    } catch (e) {
        return JSON.stringify([]);
    }
}

async function extractDetails(url) {
    try {
        const id = url.split("/watch/tv/")[1]?.split("/")[0];
        if (!id) return JSON.stringify([{ description: "", aliases: "", airdate: "" }]);
        const data = await bingrFetch(`/details/tv/${id}`);
        return JSON.stringify([{
            description: data.overview || "",
            aliases: "",
            airdate: data.year || ""
        }]);
    } catch (e) {
        return JSON.stringify([{ description: "", aliases: "", airdate: "" }]);
    }
}

async function extractEpisodes(url) {
    try {
        const id = url.split("/watch/tv/")[1]?.split("/")[0];
        if (!id) return JSON.stringify([]);
        const data = await bingrFetch(`/details/tv/${id}`);
        const seasons = (data.seasons || []).filter(s => s.season > 0);
        const episodes = [];
        for (const season of seasons) {
            for (let ep = 1; ep <= season.episodes; ep++) {
                episodes.push({
                    number: ep,
                    title: `S${season.season} E${ep}`,
                    href: `https://bingr.live/watch/tv/${id}/${season.season}/${ep}`
                });
            }
        }
        return JSON.stringify(episodes);
    } catch (e) {
        return JSON.stringify([]);
    }
}

async function extractStreamUrl(url) {
    try {
        // URL format: https://bingr.live/watch/tv/{showId}/{season}/{episode}
        const parts = url.split("/watch/tv/")[1]?.split("/");
        if (!parts || parts.length < 3) return JSON.stringify({ stream: null });
        const [showId, season, episode] = parts;

        // Get show title for search
        const details = await bingrFetch(`/details/tv/${showId}`);
        const title = details.title || "";
        const imdbId = details.imdb_id || "";

        // Try each OTT source — start with preferred, then fallback
        const otts = [PREFERRED_OTT, "nf", "pv", "hs"].filter((v, i, a) => a.indexOf(v) === i);

        for (const ott of otts) {
            try {
                // Search for the show on this OTT
                let searchUrl = `/api/v1/search?q=${encodeURIComponent(title)}&ott=${ott}&type=tv&page=1&limit=10`;
                if (imdbId) searchUrl += `&imdbId=${imdbId}`;
                const searchData = await filmFetch(searchUrl);
                const results = searchData.results || [];
                if (!results.length) continue;

                // Pick best match by title similarity
                const match = results.find(r =>
                    r.title?.toLowerCase() === title.toLowerCase()
                ) || results[0];

                // Get episodes for this show
                const showDetails = await filmFetch(`/api/v1/details/${ott}/${match.id}`);
                const eps = showDetails.episodes || [];
                const epEntry = eps.find(e =>
                    e.season === parseInt(season) && e.episode === parseInt(episode)
                );
                if (!epEntry) continue;

                // Get stream URL
                const streamData = await filmFetch(
                    `/api/v1/stream/${ott}/${epEntry.id}?title=${encodeURIComponent(title)}`
                );
                const sources = (streamData.sources || []).filter(s => s.url);
                if (!sources.length) continue;

                // Prefer 1080p, then genuine highest quality (rank by parsed height)
                const ranked = sources
                    .map(s => ({ s, h: parseInt((String(s.quality || s.label || "").match(/(\d{3,4})\s*p/i) || [])[1] || "0", 10) }))
                    .sort((a, b) => b.h - a.h);
                const preferred = (ranked.find(x => x.h === 1080) || ranked[0]).s;

                let streamUrl = preferred.url;
                if (streamUrl.startsWith("//")) streamUrl = "https:" + streamUrl;
                else if (streamUrl.startsWith("/")) streamUrl = `${FILMU_API}${streamUrl}`;
                if (streamData.token) {
                    streamUrl += (streamUrl.includes("?") ? "&" : "?") + `apiKey=${streamData.token}`;
                }

                return JSON.stringify({ stream: streamUrl });
            } catch (e) {
                continue;
            }
        }

        return JSON.stringify({ stream: null });
    } catch (e) {
        return JSON.stringify({ stream: null });
    }
}
