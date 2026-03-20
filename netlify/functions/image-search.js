const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

// ── Fetch full Tonies catalog by scraping each series page ──────────────────
async function fetchTonieCatalog() {

  // Step 1: get main page to extract series list + first batch
  const mainRes = await fetch("https://www.tonies.com/fr-fr/tonies/", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "fr-FR,fr;q=0.9"
    }
  });
  const mainHtml = await mainRes.text();
  const mainMatch = mainHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!mainMatch) throw new Error("Cannot parse tonies.com");

  const mainData = JSON.parse(mainMatch[1]);
  const productList = mainData?.props?.pageProps?.page?.productList;
  const firstBatch = productList?.products || [];

  // Extract all series slugs from aggregations
  const agg = productList?.aggregations || [];
  const seriesAgg = agg.find(a => a.key === "seriesGroups");
  const seriesSlugs = (seriesAgg?.options || [])
    .flatMap(o => (o.options || []).map(s => s.key))
    .filter(Boolean);

  // Step 2: fetch each series page in parallel (batches of 10)
  const allProducts = [...firstBatch];
  const seen = new Set(firstBatch.map(p => p.id));

  const batchSize = 10;
  for (let i = 0; i < seriesSlugs.length; i += batchSize) {
    const batch = seriesSlugs.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(slug => fetchSeriesPage(slug))
    );
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        for (const p of result.value) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            allProducts.push(p);
          }
        }
      }
    }
  }

  // Step 3: format output
  return allProducts.map(p => ({
    id: p.id,
    name: p.name + (p.subName ? " – " + p.subName : ""),
    image: p.image?.src || null,
    series: p.series?.name || p.seriesGroup?.name || "",
    slug: p.slug
  }));
}

async function fetchSeriesPage(seriesSlug) {
  try {
    const url = `https://www.tonies.com/fr-fr/tonies/${seriesSlug}/`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "fr-FR,fr;q=0.9"
      }
    });
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    const d = JSON.parse(m[1]);
    return d?.props?.pageProps?.page?.productList?.products || null;
  } catch {
    return null;
  }
}

// ── Image search via Anthropic ──────────────────────────────────────────────
async function fetchImageUrl(query, anthropicKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      system: `You are a product image finder for Toniebox figurines.
Search the web for a product image of the requested Toniebox character.
Respond with ONLY a JSON object: {"imageUrl": "https://..."}
Use any image URL that shows the Toniebox figurine. The URL must start with https://.
No explanation, no markdown, only the raw JSON.`,
      messages: [{ role: "user", content: `Find a product image URL for: ${query}` }]
    })
  });
  const data = await res.json();
  let imageUrl = null;
  for (const block of (data.content || []).filter(b => b.type === "text")) {
    const text = (block.text || "").replace(/```json|```/g, "").trim();
    try {
      const p = JSON.parse(text);
      if (p.imageUrl?.startsWith("http")) { imageUrl = p.imageUrl; break; }
    } catch {}
    const m1 = text.match(/"imageUrl"\s*:\s*"(https?:\/\/[^"\s]+)"/i);
    if (m1) { imageUrl = m1[1]; break; }
    const m2 = text.match(/https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png|webp|gif)(\?[^\s"'<>]*)?/i);
    if (m2) { imageUrl = m2[0]; break; }
  }
  return imageUrl;
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Corps invalide" }) }; }

  // ACTION: get-catalog
  if (body.action === "get-catalog") {
    try {
      const catalog = await fetchTonieCatalog();
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ catalog, total: catalog.length }) };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ACTION: image-search
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Clé Anthropic manquante" }) };
  if (!body.query) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "query manquant" }) };

  try {
    const imageUrl = await fetchImageUrl(body.query, ANTHROPIC_KEY);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ imageUrl }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
