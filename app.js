/* ===== Пилюлькин День — app.js (Medisafe-like) ===== */
(function () {
  "use strict";

  const STORAGE_KEY = "pillpals.pills.v1";
  const STREAK_KEY = "pillpals.streak.v1";
  const LAST_TAKEN_ALL_KEY = "pillpals.lastAllTaken.v1";

  // === НАСТРОЙКА PUSH-СЕРВЕРА ===
  // Адрес твоего Cloudflare Worker (замени на свой после деплоя).
  // Оставь пустым "", если push-сервер не настроен — приложение будет работать
  // только с локальными уведомлениями (пока вкладка открыта).
  const PUSH_SERVER = "https://pillpals-push.YOUR-SUBDOMAIN.workers.dev";
  // VAPID публичный ключ (из tools/gen_vapid.js / wrangler.toml)
  const VAPID_PUBLIC_KEY = "BD99UbpcIjoqoETo16XTj-DmOL8xEOJ3Ux4gNUoBg-BsKChmO3389UfUTbZ-FKk_SJ4jfUJYg1u4t9jEzxtAJoo";
  const PUSH_SUB_KEY = "pillpals.pushSub.v1";

  const TAGLINES = [
    "Ты сегодня уже принял свои волшебные пилюли?",
    "Пора подкрепиться витаминками! 🦸‍♂️",
    "Не забывай про таблетки, а то они обидятся! 😄",
    "Здоровье — это круто! Проверь свои пилюли.",
  ];
  const PRAISE = [
    "Ты супергерой! 🦸",
    "Здоровье — это круто!",
    "Ещё одна пилюля — и ты бессмертен! (шутка)",
    "Так держать! Пилюлькин гордится тобой 💪",
    "Отлично! +1 к здоровью ✨",
    "Молодец! Таблетки счастливые 😊",
  ];
  const MONTHS = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  const DOW = ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"];

  // Типы лекарств
  const MED_TYPES = {
    tablet:  { icon: "💊", label: "Таблетка" },
    capsule: { icon: "💊", label: "Капсула" },
    shot:    { icon: "💉", label: "Укол" },
    mix:     { icon: "🧪", label: "Смесь" },
    syrup:   { icon: "🥤", label: "Сироп" },
    drops:   { icon: "💧", label: "Капли" },
    ointment:{ icon: "🧴", label: "Мазь" },
    powder:  { icon: "⚗️", label: "Порошок" },
    inhaler: { icon: "🌬️", label: "Ингалятор" },
    spray:   { icon: "💦", label: "Спрей" },
    other:   { icon: "❤️", label: "Другое" },
  };
  function typeIcon(t) { return (MED_TYPES[t] && MED_TYPES[t].icon) || "💊"; }
  function typeLabel(t) { return (MED_TYPES[t] && MED_TYPES[t].label) || "Лекарство"; }

  // DOM
  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
  const calendarEl = $("calendar");
  const calMonthEl = $("calMonth");
  const modal = $("modal");
  const modalTitle = $("modalTitle");
  const nameInput = $("nameInput");
  const doseInput = $("doseInput");
  const timeInput = $("timeInput");
  const toastEl = $("toast");
  const hintEl = $("hint");
  const streakNum = $("streakNum");
  const taglineEl = $("tagline");
  const blockedInfo = $("blockedInfo");
  const installBtn = $("installBtn");
  const ringProgress = $("ringProgress");
  const ringText = $("ringText");
  const summaryText = $("summaryText");
  const summaryFill = $("summaryFill");
  const typeGrid = $("typeGrid");

  let editingId = null;
  let deferredPrompt = null;
  let selectedDate = todayStr(); // выбранная в календаре дата
  let selectedType = "tablet";   // выбранный тип лекарства в модалке

  /* ---------- Utils ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function dateStr(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function todayStr() { return dateStr(new Date()); }
  function parseDateStr(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function nowHHMM() {
    const d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function loadData() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }
  function saveData(arr) { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }

  function isTakenOn(pill, ds) {
    return !!(pill.takenDates && pill.takenDates[ds]);
  }

  /* ---------- Streak ---------- */
  function loadStreak() {
    const raw = localStorage.getItem(STREAK_KEY);
    const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
    if (!raw) return 0;
    let n = parseInt(raw, 10) || 0;
    if (last && last !== todayStr()) {
      const yest = addDays(new Date(), -1);
      if (last !== dateStr(yest)) n = 0;
    }
    return n;
  }
  function saveStreak(n) { localStorage.setItem(STREAK_KEY, String(n)); }
  function updateStreakDisplay() { streakNum.textContent = loadStreak(); }
  function recomputeStreak() {
    const pills = loadData();
    if (pills.length === 0) { updateStreakDisplay(); return; }
    const today = todayStr();
    const allTaken = pills.every(p => isTakenOn(p, today));
    if (allTaken) {
      const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
      if (last !== today) {
        const n = loadStreak() + 1;
        saveStreak(n);
        localStorage.setItem(LAST_TAKEN_ALL_KEY, today);
        showToast("🎉 Все таблетки приняты! Серия: " + n + " дн.");
      }
    }
    updateStreakDisplay();
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function showToast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  /* ---------- Звук "дзынь" ---------- */
  let audioCtx = null;
  function playDing() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.55);
    } catch (e) { /* ignore */ }
  }

  /* ---------- Прогресс-кольцо (за сегодня) ---------- */
  const RING_CIRC = 2 * Math.PI * 24; // ≈150.8
  function updateRing() {
    const pills = loadData();
    const today = todayStr();
    const total = pills.length;
    const taken = pills.filter(p => isTakenOn(p, today)).length;
    const pct = total === 0 ? 0 : Math.round((taken / total) * 100);
    ringText.textContent = pct + "%";
    ringProgress.setAttribute("stroke-dashoffset", String(RING_CIRC * (1 - pct / 100)));
  }

  /* ---------- Сводка выбранного дня ---------- */
  function updateSummary() {
    const pills = loadData();
    const total = pills.length;
    const taken = pills.filter(p => isTakenOn(p, selectedDate)).length;
    const d = parseDateStr(selectedDate);
    const label = d.getDate() + " " + MONTHS[d.getMonth()].toLowerCase();
    const isToday = selectedDate === todayStr();
    let prefix = isToday ? "Сегодня" : label;
    summaryText.textContent = prefix + ": принято " + taken + " из " + total;
    summaryFill.style.width = (total === 0 ? 0 : (taken / total) * 100) + "%";
  }

  /* ---------- Календарь ---------- */
  function dayStatus(ds) {
    const pills = loadData();
    if (pills.length === 0) return "none";
    const taken = pills.filter(p => isTakenOn(p, ds)).length;
    if (taken === 0) return "none";
    if (taken >= pills.length) return "all";
    return "some";
  }

  function renderCalendar() {
    const today = todayStr();
    const base = new Date();
    calendarEl.innerHTML = "";
    // окно: 14 дней назад .. 21 день вперёд
    for (let i = -14; i <= 21; i++) {
      const d = addDays(base, i);
      const ds = dateStr(d);
      const st = dayStatus(ds);
      const cell = document.createElement("div");
      cell.className = "cal-day " + st;
      if (ds === today) cell.classList.add("today");
      if (ds === selectedDate) cell.classList.add("selected");
      cell.dataset.date = ds;
      cell.innerHTML =
        '<span class="dow">' + DOW[d.getDay()] + "</span>" +
        '<span class="dnum">' + d.getDate() + "</span>" +
        '<span class="dot"></span>';
      cell.addEventListener("click", () => selectDate(ds));
      calendarEl.appendChild(cell);
    }
    // подпись месяца
    const md = parseDateStr(selectedDate);
    calMonthEl.textContent = MONTHS[md.getMonth()] + " " + md.getFullYear();
  }

  function scrollCalendarToSelected() {
    const cell = calendarEl.querySelector('.cal-day[data-date="' + selectedDate + '"]');
    if (cell) {
      // плавный скролл к центру
      const left = cell.offsetLeft - calendarEl.clientWidth / 2 + cell.clientWidth / 2;
      calendarEl.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    }
  }

  function selectDate(ds) {
    selectedDate = ds;
    renderCalendar();
    render();
    updateSummary();
  }

  /* ---------- Список таблеток ---------- */
  function render() {
    const pills = loadData().slice().sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    listEl.innerHTML = "";
    if (pills.length === 0) {
      hintEl.classList.remove("hidden");
      listEl.innerHTML = '<div class="empty">Пока нет ни одной таблетки.<br>Нажми «＋» внизу, чтобы добавить! 💊</div>';
      updateRing();
      updateSummary();
      return;
    }
    hintEl.classList.add("hidden");
    const isToday = selectedDate === todayStr();
    pills.forEach(p => {
      const taken = isTakenOn(p, selectedDate);
      const card = document.createElement("div");
      card.className = "card " + (taken ? "taken" : "pending");
      card.dataset.id = p.id;

      const icon = document.createElement("div");
      icon.className = "pill-icon";
      icon.textContent = taken ? "✅" : typeIcon(p.type);

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("p");
      name.className = "name";
      name.textContent = p.name || "Без названия";
      const meta = document.createElement("p");
      meta.className = "meta";
      const parts = [];
      if (p.type && p.type !== "other") parts.push(typeLabel(p.type));
      if (p.dose) parts.push(p.dose);
      meta.textContent = parts.join(" · ");
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = "⏰ " + (p.time || "--:--");
      info.appendChild(name);
      if (parts.length) info.appendChild(meta);
      info.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "actions";

      const takeBtn = document.createElement("button");
      takeBtn.className = "take-btn" + (taken ? " taken" : "");
      takeBtn.textContent = taken ? "✓ Принято" : "Выпил!";
      takeBtn.addEventListener("click", (e) => onTake(p.id, e));

      const rowBtns = document.createElement("div");
      rowBtns.className = "card-row";
      const editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.textContent = "✏️";
      editBtn.title = "Редактировать";
      editBtn.addEventListener("click", () => openModal(p.id));
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn";
      delBtn.textContent = "🗑️";
      delBtn.title = "Удалить";
      delBtn.addEventListener("click", () => onDelete(p.id));
      rowBtns.appendChild(editBtn);
      rowBtns.appendChild(delBtn);

      actions.appendChild(takeBtn);
      actions.appendChild(rowBtns);

      card.appendChild(icon);
      card.appendChild(info);
      card.appendChild(actions);
      listEl.appendChild(card);
    });

    recomputeStreak();
    updateRing();
    updateSummary();
    renderCalendar();
  }

  /* ---------- Действия ---------- */
  function onTake(id, evt) {
    const pills = loadData();
    const p = pills.find(x => x.id === id);
    if (!p) return;
    p.takenDates = p.takenDates || {};
    const wasTaken = !!p.takenDates[selectedDate];
    p.takenDates[selectedDate] = !wasTaken ? { at: Date.now() } : null;
    // сброс флага уведомления только при отметке за сегодня
    if (!wasTaken && selectedDate === todayStr()) p.lastNotified = todayStr();
    saveData(pills);

    if (!wasTaken) {
      spawnSparks(evt.currentTarget);
      playDing();
      showToast(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    }
    render();
    syncAfterChange();
  }

  // Синхронизация расписания с push-сервером (debounce)
  let syncTimer = null;
  function syncAfterChange() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await syncToServer(sub);
      } catch (e) { /* ignore */ }
    }, 800);
  }

  function spawnSparks(btn) {
    const chars = ["✨", "⭐", "💫", "🌟"];
    const rect = btn.getBoundingClientRect();
    for (let i = 0; i < 6; i++) {
      const s = document.createElement("span");
      s.className = "spark";
      s.textContent = chars[i % chars.length];
      s.style.left = (rect.left + rect.width / 2) + "px";
      s.style.top = (rect.top + rect.height / 2) + "px";
      const ang = (Math.PI * 2 * i) / 6 + Math.random() * 0.5;
      const dist = 40 + Math.random() * 30;
      s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
      s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 750);
    }
  }

  function onDelete(id) {
    if (!confirm("Удалить эту таблетку?")) return;
    saveData(loadData().filter(p => p.id !== id));
    render();
    syncAfterChange();
  }

  /* ---------- Модальное окно ---------- */
  function buildTypeGrid() {
    typeGrid.innerHTML = "";
    Object.keys(MED_TYPES).forEach(key => {
      const t = MED_TYPES[key];
      const opt = document.createElement("div");
      opt.className = "type-opt";
      opt.dataset.type = key;
      opt.innerHTML = '<span class="ticon">' + t.icon + "</span><span>" + t.label + "</span>";
      opt.addEventListener("click", () => selectType(key));
      typeGrid.appendChild(opt);
    });
  }
  function selectType(key) {
    selectedType = key;
    typeGrid.querySelectorAll(".type-opt").forEach(el => {
      el.classList.toggle("selected", el.dataset.type === key);
    });
  }

  function openModal(id) {
    editingId = id || null;
    if (id) {
      const p = loadData().find(x => x.id === id);
      modalTitle.textContent = "Редактировать";
      nameInput.value = p.name || "";
      doseInput.value = p.dose || "";
      timeInput.value = p.time || "";
      selectType(p.type || "tablet");
    } else {
      modalTitle.textContent = "Новое лекарство";
      nameInput.value = "";
      doseInput.value = "";
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      timeInput.value = pad(d.getHours()) + ":00";
      selectType("tablet");
    }
    modal.hidden = false;
    setTimeout(() => nameInput.focus(), 50);
  }
  function closeModal() { modal.hidden = true; editingId = null; }
  function onSave() {
    const name = nameInput.value.trim();
    const dose = doseInput.value.trim();
    const time = timeInput.value;
    if (!name) { showToast("Введи название лекарства 🙏"); nameInput.focus(); return; }
    if (!time) { showToast("Выбери время ⏰"); return; }
    const pills = loadData();
    if (editingId) {
      const p = pills.find(x => x.id === editingId);
      p.name = name; p.dose = dose; p.time = time; p.type = selectedType;
    } else {
      pills.push({ id: uid(), name, dose, time, type: selectedType, takenDates: {}, lastNotified: null });
    }
    saveData(pills);
    closeModal();
    render();
    showToast("Сохранено! 💾");
    syncAfterChange();
  }

  /* ---------- Уведомления ---------- */
  function updateBlockedInfo() {
    if (!("Notification" in window)) { blockedInfo.hidden = false; return; }
    blockedInfo.hidden = Notification.permission !== "denied";
  }
  async function requestNotifPermission() {
    if (!("Notification" in window)) {
      showToast("Этот браузер не поддерживает уведомления 😕");
      return;
    }
    if (Notification.permission === "default") {
      const res = await Notification.requestPermission();
      if (res === "granted") {
        showToast("Уведомления включены! 🎉");
        // подключаем фоновый push
        await subscribePush();
      }
      updateBlockedInfo();
    } else {
      updateBlockedInfo();
    }
  }

  async function fireNotification(pill) {
    let reg = null;
    try { reg = await navigator.serviceWorker.ready; } catch {}
    const title = "💊 Пилюлькин напоминает!";
    const options = {
      body: typeIcon(pill.type) + " " + pill.name + (pill.dose ? " — " + pill.dose : "") + ". Не забывай, а то они обидятся! 😄",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "pill-" + pill.id,
      data: { url: location.href, id: pill.id },
      vibrate: [200, 100, 200],
    };
    if (reg && reg.showNotification) reg.showNotification(title, options);
    else if (Notification.permission === "granted") new Notification(title, options);
    playDing();
  }

  function checkSchedule() {
    const pills = loadData();
    const today = todayStr();
    const now = nowHHMM();
    let changed = false;
    pills.forEach(p => {
      if (isTakenOn(p, today)) return;
      if (p.time && p.time <= now && p.lastNotified !== today) {
        p.lastNotified = today;
        changed = true;
        fireNotification(p);
      }
    });
    if (changed) saveData(pills);
  }

  /* ---------- Service Worker + Push ---------- */
  function registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW registration failed", err));
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "notif-click") window.focus();
      });
    }
  }

  // Конвертация VAPID public key (base64url) -> Uint8Array для subscribe
  function urlB64ToUint8Array(b64url) {
    const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // Подписка на push + отправка расписания на сервер
  async function subscribePush() {
    if (!PUSH_SERVER || !VAPID_PUBLIC_KEY) return; // сервер не настроен
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      localStorage.setItem(PUSH_SUB_KEY, JSON.stringify(sub));
      await syncToServer(sub);
      showToast("🔔 Фоновые уведомления включены!");
    } catch (e) {
      console.warn("Push subscribe failed", e);
      // не критично — локальные уведомления продолжат работать
    }
  }

  // Отправка/обновление расписания на сервере
  async function syncToServer(sub) {
    if (!PUSH_SERVER) return;
    try {
      const pills = loadData();
      const tzOffsetMin = new Date().getTimezoneOffset(); // мин (для Москвы = -180)
      await fetch(PUSH_SERVER + "/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub, pills, tzOffsetMin }),
      });
    } catch (e) {
      console.warn("syncToServer failed", e);
    }
  }

  // Отписка (при удалении всех данных и т.п.)
  async function unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        if (PUSH_SERVER) {
          await fetch(PUSH_SERVER + "/api/unregister", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          }).catch(() => {});
        }
        await sub.unsubscribe();
      }
      localStorage.removeItem(PUSH_SUB_KEY);
    } catch (e) { /* ignore */ }
  }

  /* ---------- Install prompt ---------- */
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });
  installBtn && installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) {
      showToast("Используй меню Chrome: «Добавить на главный экран» 📱");
      return;
    }
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") showToast("Ура! Иконка скоро появится 🎉");
    deferredPrompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    showToast("Установлено! Теперь работает как приложение 🎉");
  });

  /* ---------- Tagline ---------- */
  function rotateTagline() {
    let i = 0;
    taglineEl.textContent = TAGLINES[i];
    setInterval(() => {
      i = (i + 1) % TAGLINES.length;
      taglineEl.textContent = TAGLINES[i];
    }, 12000);
  }

  /* ---------- Смена дня ---------- */
  let lastDay = todayStr();
  function maybeNewDayReset() {
    const t = todayStr();
    if (t !== lastDay) {
      lastDay = t;
      selectedDate = t;
    }
    render();
  }

  /* ---------- Init ---------- */
  function init() {
    $("addBtn").addEventListener("click", () => openModal());
    $("cancelBtn").addEventListener("click", closeModal);
    $("saveBtn").addEventListener("click", onSave);
    $("recheckBtn").addEventListener("click", updateBlockedInfo);
    $("todayBtn").addEventListener("click", () => {
      selectedDate = todayStr();
      render();
      setTimeout(scrollCalendarToSelected, 50);
    });
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    const askOnce = () => {
      requestNotifPermission();
    };
    document.addEventListener("click", askOnce, { once: true });
    document.addEventListener("touchstart", askOnce, { once: true });

    registerSW();
    buildTypeGrid();
    rotateTagline();
    render();
    updateBlockedInfo();
    setTimeout(scrollCalendarToSelected, 80);

    // Если уведомления уже разрешены — переподписываемся на push
    if ("Notification" in window && Notification.permission === "granted") {
      setTimeout(subscribePush, 1500);
    }

    checkSchedule();
    setInterval(checkSchedule, 30000);
    setInterval(maybeNewDayReset, 60000);

    const params = new URLSearchParams(location.search);
    if (params.get("action") === "add") openModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
