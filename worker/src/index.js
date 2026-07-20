/**
 * Пилюлькин День — Push-сервер на Cloudflare Workers.
 *
 * Эндпоинты:
 *   POST /api/register  — { subscription, pills, tzOffsetMin } — сохранить/обновить
 *   POST /api/unregister — { endpoint } — удалить подписку
 *   GET  /api/health    — проверка живости
 *
 * Cron (каждые 2 минуты): перебирает подписки, шлёт push в нужное время.
 *
 * Хранение: KV, ключи "sub:<endpoint>".
 */

// ===== Утилиты base64url =====
function b64urlDecode(str) {
  // Web Crypto understands base64url via atob after padding fix
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

// ===== Импорт VAPID приватного ключа =====
let vapidPrivKey = null;
async function getVapidKey(env) {
  if (vapidPrivKey) return vapidPrivKey;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  vapidPrivKey = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );
  return vapidPrivKey;
}

// ===== VAPID JWT (Authorization заголовок) =====
async function vapidAuth(endpoint, env) {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || "mailto:noreply@pillpals.app",
  };
  const enc = new TextEncoder();
  const headerB64 = bufToB64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = bufToB64url(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(headerB64 + "." + payloadB64);
  const key = await getVapidKey(env);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, data
  );
  const sigB64 = bufToB64url(sig);
  return "vapid t=" + headerB64 + "." + payloadB64 + "." + sigB64 + ", k=" + env.VAPID_PUBLIC_KEY;
}

// ===== Шифрование payload по RFC 8291 (aes128gcm) =====
async function encryptPayload(message, subscription) {
  try {
    const enc = new TextEncoder();
    const plaintext = enc.encode(message);

    // Ключи подписки
    const clientPub = b64urlToBuf(subscription.keys.p256dh);
    const authSecret = b64urlToBuf(subscription.keys.auth);

    // Эфемерная ключевая пара сервера (P-256)
    const ephPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true, ["deriveBits"]
    );
    const ephPubRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", ephPair.publicKey)
    );

    // Импорт публичного ключа клиента
    const clientKey = await crypto.subtle.importKey(
      "raw", clientPub,
      { name: "ECDH", namedCurve: "P-256" },
      false, []
    );
    // Shared secret
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey }, ephPair.privateKey, 256
    );
    const sharedSecret = new Uint8Array(sharedBits);

    // HKDF: PRK = HKDF-Extract(auth, sharedSecret)
    const prk = await hkdfExtract(authSecret, sharedSecret);

    // key info = "WebPush: info\0" + clientPub + ephPub
    const keyInfo = new Uint8Array(15 + clientPub.length + ephPubRaw.length);
    keyInfo.set(enc.encode("WebPush: info\0"), 0);
    keyInfo.set(clientPub, 15);
    keyInfo.set(ephPubRaw, 15 + clientPub.length);

    // content key (16) и nonce (12)
    const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);

    // Запись: plaintext + padding (0x02, rs=4096)
    const rs = 4096;
    const record = new Uint8Array(plaintext.length + 1);
    record.set(plaintext, 0);
    record[plaintext.length] = 2; // padding delimiter

    // AES-GCM
    const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record)
    );

    // Заголовок: salt(16) + rs(4 BE) + idlen(1) + keyid(ephPub 65) + ciphertext
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const header = new Uint8Array(21 + ephPubRaw.length);
    header.set(salt, 0);
    const dv = new DataView(header.buffer);
    dv.setUint32(16, rs, false);
    header[20] = ephPubRaw.length;
    header.set(ephPubRaw, 21);

    const out = new Uint8Array(header.length + encrypted.length);
    out.set(header, 0);
    out.set(encrypted, header.length);
    return out;
  } catch (e) {
    throw new Error("encryptPayload failed: " + e.message);
  }
}

// HKDF helpers (Web Crypto)
// HKDF-Extract(salt, IKM) = HMAC-SHA256(salt, IKM) — делаем вручную,
// чтобы избежать проблем с "missing field info" в Cloudflare Workers.
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, ikm);
  return new Uint8Array(mac);
}
async function hkdfExpand(prk, info, length) {
  // Web Crypto HKDF expand не разделён, делаем вручную через HMAC
  const macKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const t0 = new Uint8Array(0);
  let t = t0;
  let okm = new Uint8Array(0);
  let counter = 1;
  while (okm.length < length) {
    const data = new Uint8Array(t.length + info.length + 1);
    data.set(t, 0);
    data.set(info, t.length);
    data[data.length - 1] = counter;
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, data));
    t = mac;
    const tmp = new Uint8Array(okm.length + mac.length);
    tmp.set(okm, 0);
    tmp.set(mac, okm.length);
    okm = tmp;
    counter++;
  }
  return okm.slice(0, length);
}

// ===== Отправка push =====
async function sendPush(subscription, message, env) {
  let payload;
  try {
    payload = await encryptPayload(message, subscription);
  } catch (e) {
    // Сохраняем ошибку для отладки
    await env.PILLS.put("debug:lastEncryptError", JSON.stringify({
      error: e.message,
      time: new Date().toISOString(),
      hasKeys: !!(subscription.keys && subscription.keys.p256dh && subscription.keys.auth),
    }));
    throw e;
  }
  const auth = await vapidAuth(subscription.endpoint, env);
  const resp = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": auth,
      "Content-Length": String(payload.length),
    },
    body: payload,
  });
  // Сохраняем результат для отладки
  const respBody = await resp.text().catch(() => "");
  await env.PILLS.put("debug:lastPushResult", JSON.stringify({
    status: resp.status,
    statusText: resp.statusText,
    body: respBody.slice(0, 300),
    time: new Date().toISOString(),
    endpoint: subscription.endpoint.slice(0, 80),
  }));
  return resp;
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
      const sub = body.subscription;
      if (!sub || !sub.endpoint) return json({ error: "no subscription" }, 400);
      const key = "sub:" + sub.endpoint;
      const record = {
        subscription: sub,
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
      const key = "sub:" + body.endpoint;
      await env.PILLS.delete(key);
      return json({ ok: true, msg: "unsubscribed" });
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
  }

  // === Отладка: сколько подписок ===
  if (url.pathname === "/api/debug" && request.method === "GET") {
    const list = await env.PILLS.list({ prefix: "sub:" });
    const subs = [];
    for (const item of list.keys) {
      const raw = await env.PILLS.get(item.name);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        subs.push({
          endpoint: rec.subscription.endpoint.slice(0, 60) + "...",
          pills: (rec.pills || []).map(p => p.name + " @" + (p.time || "?")),
          tzOffsetMin: rec.tzOffsetMin,
          updatedAt: new Date(rec.updatedAt).toISOString(),
        });
      } catch {}
    }
    // Дополнительно: последняя ошибка шифрования
    let lastErr = null;
    try {
      const errRaw = await env.PILLS.get("debug:lastEncryptError");
      if (errRaw) lastErr = JSON.parse(errRaw);
    } catch {}
    let lastPush = null;
    try {
      const pushRaw = await env.PILLS.get("debug:lastPushResult");
      if (pushRaw) lastPush = JSON.parse(pushRaw);
    } catch {}
    return json({ ok: true, count: subs.length, subscriptions: subs, lastEncryptError: lastErr, lastPushResult: lastPush });
  }

  // === Тестовый push: POST /api/test-push ===
  // Тело: { "message": "Тестовое уведомление!" }
  // Отправит push первому найденному подписчику
  if (url.pathname === "/api/test-push" && request.method === "POST") {
    try {
      const body = await request.json();
      const message = body.message || "Тестовое уведомление от Пилюлькина! 🎉";
      const list = await env.PILLS.list({ prefix: "sub:" });
      if (list.keys.length === 0) {
        return json({ error: "no subscriptions found" }, 404);
      }
      const raw = await env.PILLS.get(list.keys[0].name);
      if (!raw) return json({ error: "empty subscription" }, 500);
      const rec = JSON.parse(raw);
      const resp = await sendPush(rec.subscription, message, env);
      const respBody = await resp.text().catch(() => "");
      return json({
        ok: resp.ok || resp.status === 201,
        status: resp.status,
        statusText: resp.statusText,
        responseBody: respBody.slice(0, 200),
        sentTo: rec.subscription.endpoint.slice(0, 60) + "...",
        message,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "not found" }, 404);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ===== Cron: проверка напоминаний =====
async function checkReminders(env) {
  const now = new Date();
  // Список всех подписок
  const list = await env.PILLS.list({ prefix: "sub:" });
  for (const item of list.keys) {
    const raw = await env.PILLS.get(item.name);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }

    // Локальное время пользователя.
    // getTimezoneOffset() возвращает разницу UTC - local (в минутах).
    // Для Москвы (UTC+3) = -180. Значит local = UTC - offset = UTC + 180.
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
      const taken = !!(pill.takenDates && pill.takenDates[todayKey]);
      if (taken) continue;
      if (pill.time > userHHMM) continue; // ещё не время
      const notifKey = pill.id + ":" + todayKey;
      if (rec.notifiedToday[notifKey]) continue;

      const message = "💊 " + (pill.name || "Лекарство") +
        (pill.dose ? " — " + pill.dose : "") + ". Не забывай, а то они обидятся! 😄";

      try {
        const resp = await sendPush(rec.subscription, message, env);
        if (resp.status === 410 || resp.status === 404) {
          // подписка умерла — удаляем
          await env.PILLS.delete(item.name);
          break;
        }
        if (resp.ok || resp.status === 201) {
          rec.notifiedToday[notifKey] = Date.now();
        }
      } catch (e) {
        // сеть и т.п. — попробуем в следующий раз
      }
    }

    // чистим старые флаги (оставляем только сегодня)
    const cleaned = {};
    cleaned[todayKey] = rec.notifiedToday[todayKey] || {};
    // на самом деле ключи содержат id:date, фильтруем по todayKey
    for (const k in rec.notifiedToday) {
      if (k.endsWith(":" + todayKey)) cleaned[k] = rec.notifiedToday[k];
    }
    rec.notifiedToday = cleaned;
    await env.PILLS.put(item.name, JSON.stringify(rec));
  }
}

// ===== Точка входа =====
export default {
  async fetch(request, env) {
    // CORS preflight
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
