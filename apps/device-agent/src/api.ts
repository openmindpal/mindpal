export type PairResponse = { deviceId: string; deviceToken: string };

function safeJsonParse(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 服务器返回非JSON响应（如502/503 HTML错误页），返回错误对象
    return { _parseError: true, _rawText: text.slice(0, 200) };
  }
}

export async function apiPostJson<T>(params: { apiBase: string; path: string; token?: string; body: any }) {
  const res = await fetch(params.apiBase.replace(/\/+$/, "") + params.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(params.token ? { authorization: `Device ${params.token}` } : {}),
    },
    body: JSON.stringify(params.body ?? {}),
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  return { status: res.status, json: json as T };
}

export async function apiGetJson<T>(params: { apiBase: string; path: string; token: string }) {
  const res = await fetch(params.apiBase.replace(/\/+$/, "") + params.path, {
    method: "GET",
    headers: { authorization: `Device ${params.token}` },
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  return { status: res.status, json: json as T };
}

