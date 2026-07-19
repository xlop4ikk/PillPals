/**
 * Генератор VAPID-ключей для Web Push.
 * Запуск:  node tools/gen_vapid.js
 *
 * Выводит:
 *   VAPID_PUBLIC_KEY  — для клиента (applicationServerKey)
 *   VAPID_PRIVATE_JWK — для Worker (подпись JWT)
 *
 * Скопируй значения в worker/wrangler.toml (или задай как secrets).
 */
const crypto = require("crypto");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

// Публичный ключ в формате "uncompressed point" (65 байт: 0x04 + X[32] + Y[32])
const spkiDer = publicKey.export({ type: "spki", format: "der" });
const point = spkiDer.slice(-65); // последние 65 байт — точка
const vapidPublicKey = point.toString("base64url");

// Приватный ключ как JWK (удобно для Web Crypto в Worker)
const privJwk = privateKey.export({ format: "jwk" });

console.log("=== VAPID ключи сгенерированы ===\n");
console.log("VAPID_PUBLIC_KEY (для app.js / клиента):");
console.log(vapidPublicKey);
console.log("\nVAPID_PRIVATE_JWK (для Worker — вставь в wrangler.toml одной строкой):");
console.log(JSON.stringify(privJwk));
console.log("\nГотово. Не коммить приватный ключ в публичный репозиторий!");
