const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

// ── Fetch full Tonies catalog from tonies.com (FR) ───────────────────────────
async function fetchTonieCatalog() {
  const PAGE_SIZE = 44;

  // Step 1: fetch the main page to get buildId + first batch
  const pageRes = await fetch("https://www.tonies.com/fr-fr/tonies/", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9"
    }
  });
  const html = await pageRes.text();

  // Extract __NEXT_DATA__
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find __NEXT_DATA__");

  const nextData = JSON.parse(match[1]);
  const buildId = nextData.buildId;
  const productList = nextData?.props?.pageProps?.page?.productList;
  const total = productList?.total || 0;
  const firstBatch = productList?.products || [];

  // Step 2: fetch remaining pages via Next.js data endpoint
  const allProducts = [...firstBatch];
  const totalPages = Math.ceil(total / PAGE_SIZE);

  for (let page = 1; page < totalPages; page++) {
    const offset = page * PAGE_SIZE;
    try {
      const r = await fetch(`https://www.tonies.com/_next/data/${buildId}/fr-fr/tonies.json?offset=${offset}`, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json",
          "x-nextjs-data": "1"
        }
      });
      if (!r.ok) break;
      const d = await r.json();
      const batch = d?.pageProps?.page?.productList?.products || [];
      allProducts.push(...batch);
    } catch { break; }
  }

  // Step 3: deduplicate and format
  const seen = new Set();
  return allProducts
    .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .map(p => ({
      id: p.id,
      name: p.name + (p.subName ? " – " + p.subName : ""),
      image: p.image?.src || null,
      series: p.series?.name || p.seriesGroup?.name || "",
      slug: p.slug,
      color: "#" + Math.floor(Math.abs(Math.sin(p.id.charCodeAt(0) * 9999) * 16777215)).toString(16).padStart(6, "0"),
      emoji: "🎵"
    }));
}

// ── Image search via Anthropic ───────────────────────────────────────────────
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
Use any image URL that shows the Toniebox figurine clearly.
The URL must start with https://. No explanation, no markdown, only the raw JSON.`,
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

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Corps invalide" }) }; }

  // ACTION: get-catalog
  if (body.action === "get-catalog") {
    try {
      const catalog = await fetchTonieCatalog();
      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ catalog }) };
    } catch (err) {
      return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ACTION: image-search (default)
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: "Clé API manquante" }) };
  }

  const query = body.query;
  if (!query) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "query manquant" }) };
  }

  try {
    const imageUrl = await fetchImageUrl(query, ANTHROPIC_KEY);
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ imageUrl }) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
