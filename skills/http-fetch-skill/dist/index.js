// HTTP Fetch skill - fetches URL content
exports.execute = async function execute(req) {
  const url = String(req?.input?.url ?? "");
  if (!url) return { status: 400, body: "missing url" };
  try {
    const res = await fetch(url, { method: req?.input?.method ?? "GET" });
    const body = await res.text();
    return { status: res.status, body };
  } catch (e) {
    return { status: 500, body: String(e?.message ?? e) };
  }
};
