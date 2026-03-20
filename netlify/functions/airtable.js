const BASE_URL = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE}/${encodeURIComponent(process.env.AIRTABLE_TABLE || "Tonies")}`;
const HEADERS_AT = () => ({
  "Authorization": `Bearer ${process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json"
});
const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  if (!process.env.AIRTABLE_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "AIRTABLE_TOKEN manquant" }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Corps invalide" }) }; }

  const { action, data } = body;

  try {
    // LIST
    if (action === "list") {
      let all = [], offset = null;
      do {
        const url = BASE_URL + "?pageSize=100" + (offset ? `&offset=${offset}` : "");
        const r = await fetch(url, { headers: HEADERS_AT() });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        all = all.concat(d.records);
        offset = d.offset;
      } while (offset);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ records: all }) };
    }

    // CREATE
    if (action === "create") {
      const r = await fetch(BASE_URL, {
        method: "POST", headers: HEADERS_AT(),
        body: JSON.stringify({ records: [{ fields: data }] })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ record: d.records[0] }) };
    }

    // DELETE
    if (action === "delete") {
      await fetch(`${BASE_URL}/${data.id}`, { method: "DELETE", headers: HEADERS_AT() });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // PATCH
    if (action === "patch") {
      await fetch(`${BASE_URL}/${data.id}`, {
        method: "PATCH", headers: HEADERS_AT(),
        body: JSON.stringify({ fields: data.fields })
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Action inconnue" }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
