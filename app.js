/* ===== Пилюлькин День — app.js ===== */
(function () {
  "use strict";

  const STORAGE_KEY = "pillpals.pills.v1";
  const STREAK_KEY = "pillpals.streak.v1";
  const LAST_TAKEN_ALL_KEY = "pillpals.lastAllTaken.v1";

  // Случайные фразы
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

  // DOM
  const $ = (id) => document.getElementById(id);
  const listEl = $("list");
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

  let editingId = null;
  let deferredPrompt = null;

  /* ---------- Utils ---------- */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function nowHHMM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function loadData() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }
  function saveData(arr) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }

  /* ---------- Streak ---------- */
  function loadStreak() {
    const raw = localStorage.getItem(STREAK_KEY);
    const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
    if (!raw) return 0;
    let n = parseInt(raw, 10) || 0;
    // Если последний "полный день" был не сегодня и не вчера — обнуляем
    if (last && last !== todayStr()) {
      const yest = new Date();
      yest.setDate(yest.getDate() - 1);
      const yestStr = yest.getFullYear() + "-" + String(yest.getMonth() + 1).padStart(2, "0") + "-" + String(yest.getDate()).padStart(2, "0");
      if (last !== yestStr) n = 0;
    }
    return n;
  }
  function saveStreak(n) {
    localStorage.setItem(STREAK_KEY, String(n));
  }
  function updateStreakDisplay() {
    streakNum.textContent = loadStreak();
  }
  function recomputeStreak() {
    const pills = loadData();
    if (pills.length === 0) { updateStreakDisplay(); return; }
    const allTaken = pills.every(p => (p.takenDates && p.takenDates[todayStr()]));
    if (allTaken) {
      const last = localStorage.getItem(LAST_TAKEN_ALL_KEY);
      if (last !== todayStr()) {
        const n = loadStreak() + 1;
        saveStreak(n);
        localStorage.setItem(LAST_TAKEN_ALL_KEY, todayStr());
        showToast("🎉 Все таблетки приняты! Серия: " + n + " дн.");
      }
    } else {
      // если серия была, но сегодня ещё не всё принято — оставляем как есть до конца дня
      // обнуляем только когда прошёл день без полного приёма (см. loadStreak)
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

  /* ---------- Звук "дзынь" через WebAudio ---------- */
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

  /* ---------- Render ---------- */
  function render() {
    const pills = loadData();
    listEl.innerHTML = "";
    if (pills.length === 0) {
      hintEl.classList.remove("hidden");
      listEl.innerHTML = '<div class="empty">Пока нет ни одной таблетки.<br>Нажми «＋ Добавить таблетку»! 💊</div>';
      return;
    }
    hintEl.classList.add("hidden");
    const today = todayStr();
    pills.forEach(p => {
      const taken = !!(p.takenDates && p.takenDates[today]);
      const card = document.createElement("div");
      card.className = "card " + (taken ? "taken" : "pending");
      card.dataset.id = p.id;

      const icon = document.createElement("div");
      icon.className = "pill-icon";
      icon.textContent = taken ? "✅" : "💊";

      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("p");
      name.className = "name";
      name.textContent = p.name || "Без названия";
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = p.dose ? "Дозировка: " + p.dose : "";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = "⏰ " + (p.time || "--:--");
      info.appendChild(name);
      if (p.dose) info.appendChild(meta);
      info.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "actions";

      const takeBtn = document.createElement("button");
      takeBtn.className = "take-btn" + (taken ? " taken" : "");
      takeBtn.textContent = taken ? "Принято" : "Выпил!";
      takeBtn.addEventListener("click", (e) => onTake(p.id, e));

      const rowBtns = document.createElement("div");
      rowBtns.style.display = "flex";
      rowBtns.style.gap = "4px";
      rowBtns.style.justifyContent = "center";

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
  }

  /* ---------- Actions ---------- */
  function onTake(id, evt) {
    const pills = loadData();
    const p = pills.find(x => x.id === id);
    if (!p) return;
    const today = todayStr();
    p.takenDates = p.takenDates || {};
    const wasTaken = !!p.takenDates[today];
    p.takenDates[today] = !wasTaken ? { at: Date.now() } : null;
    // сбрасываем флаг уведомления на сегодня
    if (!wasTaken) p.lastNotified = null;
    saveData(pills);

    if (!wasTaken) {
      // анимация звёздочек
      spawnSparks(evt.currentTarget);
      playDing();
      showToast(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    }
    render();
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
      s.style.position = "fixed";
      s.style.zIndex = "70";
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 750);
    }
  }

  function onDelete(id) {
    if (!confirm("Удалить эту таблетку?")) return;
    const pills = loadData().filter(p => p.id !== id);
    saveData(pills);
    render();
  }

  /* ---------- Modal ---------- */
  function openModal(id) {
    editingId = id || null;
    if (id) {
      const p = loadData().find(x => x.id === id);
      modalTitle.textContent = "Редактировать";
      nameInput.value = p.name || "";
      doseInput.value = p.dose || "";
      timeInput.value = p.time || "";
    } else {
      modalTitle.textContent = "Новая таблетка";
      nameInput.value = "";
      doseInput.value = "";
      // дефолтное время — ближайший целый час
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      timeInput.value = String(d.getHours()).padStart(2, "0") + ":00";
    }
    modal.hidden = false;
    setTimeout(() => nameInput.focus(), 50);
  }
  function closeModal() {
    modal.hidden = true;
    editingId = null;
  }
  function onSave() {
    const name = nameInput.value.trim();
    const dose = doseInput.value.trim();
    const time = timeInput.value;
    if (!name) { showToast("Введи название таблетки 🙏"); nameInput.focus(); return; }
    if (!time) { showToast("Выбери время ⏰"); return; }
    const pills = loadData();
    if (editingId) {
      const p = pills.find(x => x.id === editingId);
      p.name = name; p.dose = dose; p.time = time;
    } else {
      pills.push({ id: uid(), name, dose, time, takenDates: {}, lastNotified: null });
    }
    saveData(pills);
    closeModal();
    render();
    showToast("Сохранено! 💾");
  }

  /* ---------- Notifications ---------- */
  function updateBlockedInfo() {
    if (!("Notification" in window)) {
      blockedInfo.hidden = false;
      return;
    }
    blockedInfo.hidden = Notification.permission !== "denied";
  }
  async function requestNotifPermission() {
    if (!("Notification" in window)) {
      showToast("Этот браузер не поддерживает уведомления 😕");
      return;
    }
    if (Notification.permission === "default") {
      const res = await Notification.requestPermission();
      if (res === "granted") showToast("Уведомления включены! 🎉");
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
      body: "Пора принять: " + pill.name + (pill.dose ? " (" + pill.dose + ")" : "") + " — не забывай, а то они обидятся! 😄",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: "pill-" + pill.id,
      data: { url: location.href, id: pill.id },
      vibrate: [200, 100, 200],
    };
    if (reg && reg.showNotification) {
      reg.showNotification(title, options);
    } else if (Notification.permission === "granted") {
      new Notification(title, options);
    }
    playDing();
  }

  function checkSchedule() {
    const pills = loadData();
    const today = todayStr();
    const now = nowHHMM();
    let changed = false;
    pills.forEach(p => {
      const taken = !!(p.takenDates && p.takenDates[today]);
      if (taken) return;
      if (p.time && p.time <= now) {
        // уведомляем раз в день
        if (p.lastNotified !== today) {
          p.lastNotified = today;
          changed = true;
          fireNotification(p);
        }
      }
    });
    if (changed) saveData(pills);
  }

  /* ---------- Service Worker ---------- */
  function registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW registration failed", err));
      // клик по уведомлению -> фокус/открыть
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "notif-click") {
          window.focus();
        }
      });
    }
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

  /* ---------- Tagline rotation ---------- */
  function rotateTagline() {
    let i = 0;
    taglineEl.textContent = TAGLINES[i];
    setInterval(() => {
      i = (i + 1) % TAGLINES.length;
      taglineEl.textContent = TAGLINES[i];
    }, 12000);
  }

  /* ---------- Reset taken at new day ---------- */
  function maybeNewDayReset() {
    // takenDates хранятся по датам, поэтому "сброс" происходит автоматически —
    // мы просто перерисовываем и пересчитываем серию.
    render();
  }

  /* ---------- Init ---------- */
  function init() {
    // кнопки
    $("addBtn").addEventListener("click", () => openModal());
    $("cancelBtn").addEventListener("click", closeModal);
    $("saveBtn").addEventListener("click", onSave);
    $("recheckBtn").addEventListener("click", updateBlockedInfo);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

    // запрос разрешения при первом запуске (после взаимодействия)
    const askOnce = () => {
      requestNotifPermission();
      document.removeEventListener("click", askOnce);
      document.removeEventListener("touchstart", askOnce);
    };
    document.addEventListener("click", askOnce, { once: true });
    document.addEventListener("touchstart", askOnce, { once: true });

    registerSW();
    rotateTagline();
    render();
    updateBlockedInfo();

    // планировщик уведомлений — пока вкладка открыта
    checkSchedule();
    setInterval(checkSchedule, 30000); // каждые 30 сек

    // проверка смены дня — каждую минуту перерисовать
    setInterval(maybeNewDayReset, 60000);

    // обрабатываем параметр ?action=add
    const params = new URLSearchParams(location.search);
    if (params.get("action") === "add") openModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
