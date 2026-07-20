/**
 * Пилюлькин День — Push-сервер на Cloudflare Workers.
 *
 * Эндпоинты:
 *   POST /api/register  — сохранить подписку + расписание
 *   POST /api/unregister — удалить подписку
 *   GET  /api/debug     — отладка (подписки, ошибки)
 *   POST /api/test-push — отправить тестовый push первой подписке
 *   GET  /api/health    — проверка
 *
 * Cron: каждые 2 минуты проверяет расписание и шлёт push.
 */

// ===== Утилиты =====
function b64urlDecode(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  return atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
function b64urlToBuf(str) {
  const bin = b64urlDecode(str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bufToB64url(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ===== VAPID =====
let vapidKeyCache = null;
async function getVapidKey(env) {
  if (vapidKeyCache) return vapidKeyCache;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  vapidKeyCache = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  return vapidKeyCache;
}

async function vapidAuth(endpoint, env) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: "mailto:xatabeach42@gmail.com",
  };
  const enc = new TextEncoder();
  const hb = bufToB64url(enc.encode(JSON.stringify(header)));
  const pb = bufToB64url(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(hb + "." + pb);
  const key = await getVapidKey(env);
  const sig = bufToB64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)));
  return "vapid t=" + hb + "." + pb + "." + sig + ", k=" + env.VAPID_PUBLIC_KEY;
}

// ===== Шифрование payload (RFC 8291) =====
async function encryptPayload(message, subscription) {
  const enc = new TextEncoder();
  const plain = enc.encode(message);

  // 1. Получаем ключи клиента из подписки
  const clientPub = b64urlToBuf(subscription.keys.p256dh);
  const authSecret = b64urlToBuf(subscription.keys.auth);

  // 2. Генерируем эфемерную ECDH-пару сервера
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));

  // 3. Импортируем публичный ключ клиента и получаем общий секрет
  const clientKey = await crypto.subtle.importKey(
    "raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, eph.privateKey, 256)
  );

  // 4. HKDF-Extract: PRK = HMAC-SHA256(authSecret, sharedBits)
  const hmacKey = await crypto.subtle.importKey(
    "raw", authSecret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, sharedBits));

  // 5. key_info = "Content-Encoding: aes128gcm\0" + clientPub + ephPub
  const label = "Content-Encoding: aes128gcm\0";
  const labelBytes = enc.encode(label);
  const keyInfo = new Uint8Array(labelBytes.length + clientPub.length + ephPub.length);
  keyInfo.set(labelBytes, 0);
  keyInfo.set(clientPub, labelBytes.length);
  keyInfo.set(ephPub, labelBytes.length + clientPub.length);

  // 6. CEK и nonce через HKDF-Expand (ручной HMAC)
  async function hkdfExpandSalt(prk, info, len) {
    const k = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    let T = new Uint8Array(0);
    let result = new Uint8Array(0);
    let counter = 1;
    while (result.length < len) {
      const data = new Uint8Array(T.length + info.length + 1);
      data.set(T, 0);
      data.set(info, T.length);
      data[data.length - 1] = counter++;
      T = new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
      const tmp = new Uint8Array(result.length + T.length);
      tmp.set(result, 0);
      tmp.set(T, result.length);
      result = tmp;
    }
    return result.slice(0, len);
  }

  const cek = await hkdfExpandSalt(prk, keyInfo, 16);
  const nonce = await hkdfExpandSalt(prk, keyInfo, 12);

  // 7. Шифруем AES-GCM
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = new Uint8Array(plain.length + 1);
  record.set(plain, 0);
  record[plain.length] = 2;
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record)
  );

  // 8. Заголовок: salt(16) + rs(4) + idlen(1) + keyid(n) + ciphertext
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = new Uint8Array(21 + ephPub.length);
  header.set(salt, 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(16, 4096, false);
  header[20] = ephPub.length;
  header.set(ephPub, 21);

  const out = new Uint8Array(header.length + cipher.length);
  out.set(header, 0);
  out.set(cipher, header.length);
  return out;
}

// ===== Отправка push =====
async function sendPush(sub, msg, env) {
  let payload;
  try {
    payload = await encryptPayload(msg, sub);
  } catch (e) {
    await env.PILLS.put("debug:lastError", JSON.stringify({
      where: "encryptPayload",
      error: e.message,
      stack: e.stack,
      time: new Date().toISOString(),
    }));
    throw e;
  }

  const auth = await vapidAuth(sub.endpoint, env);
  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Authorization: auth,
      "Content-Length": String(payload.length),
    },
    body: payload,
  });

  const respBody = await resp.text().catch(() => "");
  await env.PILLS.put("debug:lastPushResult", JSON.stringify({
    status: resp.status,
    statusText: resp.statusText,
    body: respBody.slice(0, 500),
    time: new Date().toISOString(),
  }));

  return { resp, body: respBody };
}

// ===== HTTP-обработчик =====
async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/register" && request.method === "POST") {
    try {
      const body = await request.json();
      if (!body.subscription || !body.subscription.endpoint) {
        return json({ error: "missing subscription" }, 400);
      }
      const key = "sub:" + body.subscription.endpoint;
      const record = {
        subscription: body.subscription,
        pills: body.pills || [],
        tzOffsetMin: body.tzOffsetMin || 0,
        updatedAt: Date.now(),
        notifiedToday: {},
      };
      await env.PILLS.put(key, JSON.stringify(record));
      return json({ ok: true, msg: "subscribed" });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  if (url.pathname === "/api/unregister" && request.method === "POST") {
    try {
      const body = await request.json();
      await env.PILLS.delete("sub:" + body.endpoint);
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  if (url.pathname === "/api/debug" && request.method === "GET") {
    const list = await env.PILLS.list({ prefix: "sub:" });
    const subs = [];
    for (const item of list.keys) {
      try {
        const rec = JSON.parse(await env.PILLS.get(item.name));
        subs.push({
          endpoint: (rec.subscription.endpoint || "").slice(0, 70) + "...",
          pills: (rec.pills || []).map(p => (p.name || "?") + " @" + (p.time || "?")),
          tzOffsetMin: rec.tzOffsetMin,
          updatedAt: new Date(rec.updatedAt).toISOString(),
        });
      } catch {}
    }
    let lastErr = null, lastPush = null;
    try { const r = await env.PILLS.get("debug:lastError"); if (r) lastErr = JSON.parse(r); } catch {}
    try { const r = await env.PILLS.get("debug:lastPushResult"); if (r) lastPush = JSON.parse(r); } catch {}
    return json({ ok: true, count: subs.length, subscriptions: subs, lastError: lastErr, lastPushResult: lastPush });
  }

  if (url.pathname === "/api/test-push" && request.method === "POST") {
    try {
      const body = await request.json();
      const msg = body.message || "Тестовое уведомление!";
      const list = await env.PILLS.list({ prefix: "sub:" });
      if (list.keys.length === 0) return json({ error: "no subscriptions" }, 404);
      const rec = JSON.parse(await env.PILLS.get(list.keys[0].name));
      const result = await sendPush(rec.subscription, msg, env);
      return json({
        ok: result.resp.ok || result.resp.status === 201,
        status: result.resp.status,
        statusText: result.resp.statusText,
        body: result.body.slice(0, 300),
      });
    } catch (e) {
      return json({ error: String(e), stack: e.stack }, 500);
    }
  }

  return json({ error: "not found" }, 404);
}

// ===== Cron =====
async function checkReminders(env) {
  const now = new Date();
  const list = await env.PILLS.list({ prefix: "sub:" });
  for (const item of list.keys) {
    try {
      const rec = JSON.parse(await env.PILLS.get(item.name));
      const offset = rec.tzOffsetMin || 0;
      const userNow = new Date(now.getTime() - offset * 60000);
      const todayKey = userNow.getFullYear() + "-" +
        String(userNow.getMonth() + 1).padStart(2, "0") + "-" +
        String(userNow.getDate()).padStart(2, "0");
      const userHHMM = String(userNow.getHours()).padStart(2, "0") + ":" +
        String(userNow.getMinutes()).padStart(2, "0");

      rec.notifiedToday = rec.notifiedToday || {};
      for (const pill of (rec.pills || [])) {
        if (!pill.time) continue;
        // Проверяем период действия
        if (pill.dateStart && todayKey < pill.dateStart) continue;
        if (pill.dateEnd && todayKey > pill.dateEnd) continue;
        if (pill.takenDates && pill.takenDates[todayKey]) continue;
        if (pill.time > userHHMM) continue;
        const nk = pill.id + ":" + todayKey;
        if (rec.notifiedToday[nk]) continue;

        const msg = "💊 " + (pill.name || "Лекарство") + (pill.dose ? " — " + pill.dose : "");
        const result = await sendPush(rec.subscription, msg, env);
        if (result.resp.status === 410 || result.resp.status === 404) {
          await env.PILLS.delete(item.name);
          break;
        }
        if (result.resp.ok || result.resp.status === 201) {
          rec.notifiedToday[nk] = Date.now();
        }
      }

      const cleaned = {};
      for (const k in rec.notifiedToday) {
        if (k.endsWith(":" + todayKey)) cleaned[k] = rec.notifiedToday[k];
      }
      rec.notifiedToday = cleaned;
      await env.PILLS.put(item.name, JSON.stringify(rec));
    } catch (e) {
      await env.PILLS.put("debug:cronError", JSON.stringify({
        error: e.message,
        key: item.name,
        time: new Date().toISOString(),
      }));
    }
  }
}

// ===== Точка входа =====
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }
    return handleRequest(request, env);
  },
  async scheduled(event, env) {
    await checkReminders(env);
  },
};
