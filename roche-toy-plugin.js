// ============================================================
// 插件：AI 玩具控制（中繼版）for Roche
// ------------------------------------------------------------
// 它做的事：後台常駐，監控指定會話最近 20 則訊息，從 AI 回覆裡
// 解析 [toy:震動:電流] / [toy:更強] / [toy:停]，送到你的 Cloudflare
// 中繼站；iPad 的 Bluefy 再把它變成玩具的實際動作。
//
// 這個插件「不碰藍牙」—— iOS 上瀏覽器連不了藍牙，所以藍牙端在 iPad。
// 插件只負責把指令送上中繼。
//
// 搭配：中繼站 Worker(roomfun-relay) + iPad 接收端(roomfun-ipad.html)
//       + 世界書(roche-toy-worldbook.txt 貼進 Roche 全局設定)
//
// 本檔基於你提供、可運作的原始 plugin.js 改寫，沿用其真實 API：
//   roche.memory.getShortTerm / roche.persona.getActiveUserPersona /
//   roche.conversation.list / roche.storage / roche.ui.toast
// ============================================================
(function () {
  'use strict';

  // ---------- 全局狀態（後台常駐，不隨頁面關閉銷毀）----------
  const S = {
    roche: null,
    settings: { relay: '', secret: '' },
    currentConvId: '',
    currentUserPersonaId: null,
    lastProcessedTs: 0,
    isMonitoring: false,
    monitorInterval: null,
    lastVibe: 0,
    lastEstim: 0,
    lastPump: 0,
    lastCmdText: '待命',
    onStatusChange: null,   // UI 開著時的回呼
  };

  const POLL_MS = 1500;
  const READ_COUNT = 20;

  // ============================================================
  // 指令解析：從一則 AI 訊息文字取出最後一個 [toy:...]
  // ============================================================
  function clamp(n) { n = parseInt(n, 10); if (isNaN(n)) n = 0; return Math.max(0, Math.min(100, n)); }

  function parseCommand(text) {
    if (!text) return null;
    const all = [...text.matchAll(/\[toy:([^\]]+)\]/gi)];
    if (!all.length) return null;
    const inner = all[all.length - 1][1].trim();   // 只取最後一個
    if (/^停|^stop$/i.test(inner)) return { stop: true, vibe: 0, estim: 0, pump: 0 };
    // 三通道：震動:電流:砲機
    const three = inner.match(/^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)$/);
    if (three) return { vibe: clamp(+three[1]), estim: clamp(+three[2]), pump: clamp(+three[3]) };
    // 兩通道：震動:電流（砲機維持）
    const two = inner.match(/^(\d+)\s*:\s*(\d+)$/);
    if (two) return { vibe: clamp(+two[1]), estim: clamp(+two[2]), pump: S.lastPump };
    // 語意詞：相對目前值增減（作用在震動）
    let v = S.lastVibe, e = S.lastEstim, p = S.lastPump;
    if (/更強|加強|強一點|increase|up/i.test(inner)) v = Math.min(100, v + 20);
    else if (/更弱|減弱|弱一點|輕|decrease|down/i.test(inner)) v = Math.max(0, v - 20);
    else if (/最強|max/i.test(inner)) v = 100;
    else { const s = inner.match(/^(\d+)$/); if (s) v = clamp(+s[1]); }
    return { vibe: v, estim: e, pump: p };
  }

  // ============================================================
  // 送中繼站
  // ============================================================
  async function sendRelay(cmd) {
    const { relay, secret } = S.settings;
    if (!relay || !secret) { updateLastCmd('⚠️ 未設定中繼'); return false; }
    const q = cmd.stop ? 'stop=1' : `v=${cmd.vibe}&e=${cmd.estim}&p=${cmd.pump}`;
    const url = `${relay.replace(/\/$/, '')}/set?k=${encodeURIComponent(secret)}&${q}`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 403) { updateLastCmd('❌ 密語不符'); return false; }
      S.lastVibe = cmd.vibe; S.lastEstim = cmd.estim; S.lastPump = cmd.pump;
      updateLastCmd(cmd.stop ? '✅ 停止' : `✅ 震${cmd.vibe} 電${cmd.estim} 砲${cmd.pump}`);
      return true;
    } catch (e) {
      updateLastCmd('❌ 送出失敗');
      return false;
    }
  }

  function updateLastCmd(t) { S.lastCmdText = t; if (S.onStatusChange) S.onStatusChange(); }

  // ============================================================
  // 監控：讀最近訊息，找最新一則未處理的 AI 指令
  // ============================================================
  async function checkMessages() {
    if (!S.currentConvId || !S.roche) return;
    try {
      if (!S.currentUserPersonaId) {
        const active = await S.roche.persona.getActiveUserPersona();
        S.currentUserPersonaId = active ? active.id : null;
      }
      const msgs = await S.roche.memory.getShortTerm({
        conversationId: S.currentConvId,
        limit: READ_COUNT
      });
      if (!Array.isArray(msgs) || !msgs.length) return;
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      let newCmd = null, newTs = S.lastProcessedTs;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.senderId === S.currentUserPersonaId) continue;      // 跳過使用者自己
        if (m.type === 'system' || m.type === 'action') continue; // 跳過系統訊息
        const ts = m.timestamp || 0;
        if (ts <= S.lastProcessedTs) continue;                    // 已處理過
        const cmd = parseCommand(m.text || '');
        if (cmd) { newCmd = cmd; newTs = ts; break; }
      }
      if (newCmd) {
        const ok = await sendRelay(newCmd);
        if (ok) {
          S.lastProcessedTs = newTs;
          await S.roche.storage.set('toyLastTs', S.lastProcessedTs);
        }
      }
    } catch (e) { /* 靜默，避免干擾 */ }
  }

  function startMonitor() {
    if (S.monitorInterval) clearInterval(S.monitorInterval);
    S.monitorInterval = setInterval(checkMessages, POLL_MS);
    S.isMonitoring = true;
    if (S.roche) S.roche.storage.set('toyAutoMonitor', true);
    if (S.onStatusChange) S.onStatusChange();
  }
  function stopMonitor() {
    if (S.monitorInterval) { clearInterval(S.monitorInterval); S.monitorInterval = null; }
    S.isMonitoring = false;
    if (S.roche) S.roche.storage.set('toyAutoMonitor', false);
    if (S.onStatusChange) S.onStatusChange();
  }
  async function hardStop() {
    await sendRelay({ stop: true, vibe: 0, estim: 0 });
  }

  // ============================================================
  // 插件 UI
  // ============================================================
  const pluginApp = {
    id: 'toy-relay-home',
    name: '玩具控制',
    icon: 'bluetooth',

    async mount(container, roche) {
      if (!S.roche) {
        S.roche = roche;
        S.settings = (await roche.storage.get('toyRelaySettings')) || { relay: '', secret: '' };
        S.currentConvId = (await roche.storage.get('toyConversationId')) || '';
        S.lastProcessedTs = (await roche.storage.get('toyLastTs')) || 0;
        const auto = (await roche.storage.get('toyAutoMonitor')) || false;
        if (auto && S.currentConvId && !S.isMonitoring) startMonitor();
      }

      container.innerHTML = `
        <div style="padding:14px;max-width:480px;margin:0 auto;font-size:14px;color:#2f3a3b;font-family:-apple-system,sans-serif">
          <h3 style="margin:0 0 4px">AI 玩具控制</h3>
          <p style="margin:0 0 14px;font-size:12px;color:#888">設定後可關閉此頁，監控在後台持續運行。藍牙端在 iPad。</p>

          <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">中繼站網址</label>
          <input id="tr-relay" type="text" placeholder="https://roomfun-relay.xxx.workers.dev"
            style="width:100%;padding:9px;border:1px solid #e7ddcb;border-radius:8px;margin-bottom:10px;box-sizing:border-box">

          <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">通關密語</label>
          <input id="tr-secret" type="text" placeholder="跟中繼站、iPad 同一串"
            style="width:100%;padding:9px;border:1px solid #e7ddcb;border-radius:8px;margin-bottom:10px;box-sizing:border-box">

          <label style="display:block;font-size:12px;color:#888;margin-bottom:4px">監控哪個會話</label>
          <select id="tr-conv" style="width:100%;padding:9px;border:1px solid #e7ddcb;border-radius:8px;margin-bottom:14px;box-sizing:border-box">
            <option value="">-- 選擇要監控的會話 --</option>
          </select>

          <div style="display:flex;gap:8px;margin-bottom:10px">
            <button id="tr-save" style="flex:1;padding:11px;border:none;border-radius:9px;background:#1fb3bb;color:#fff;font-weight:600">儲存</button>
            <button id="tr-toggle" style="flex:1;padding:11px;border:none;border-radius:9px;background:#36c9d1;color:#fff;font-weight:600">開始監控</button>
          </div>
          <button id="tr-stop" style="width:100%;padding:11px;border:none;border-radius:9px;background:#e05a43;color:#fff;font-weight:600">強制停止</button>

          <div id="tr-status" style="margin-top:12px;font-size:12px;color:#888"></div>
        </div>`;

      const q = s => container.querySelector(s);
      const relayIn = q('#tr-relay'), secretIn = q('#tr-secret'), convSel = q('#tr-conv');
      const btnSave = q('#tr-save'), btnToggle = q('#tr-toggle'), btnStop = q('#tr-stop'), statusEl = q('#tr-status');

      relayIn.value = S.settings.relay || '';
      secretIn.value = S.settings.secret || '';

      // 填入會話清單
      try {
        const convs = await roche.conversation.list();
        for (const c of convs) {
          const label = c.name || c.handle || c.id;
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = `${label}${c.isGroup ? '（群聊）' : ''}`;
          if (c.id === S.currentConvId) opt.selected = true;
          convSel.appendChild(opt);
        }
      } catch (e) {}

      function refresh() {
        btnToggle.textContent = S.isMonitoring ? '停止監控' : '開始監控';
        btnToggle.style.background = S.isMonitoring ? '#aab0ad' : '#36c9d1';
        statusEl.textContent = `狀態：${S.isMonitoring ? '監控中' : '待命'}　｜　${S.lastCmdText}`;
      }
      S.onStatusChange = refresh;
      refresh();

      btnSave.onclick = async () => {
        S.settings = { relay: relayIn.value.trim().replace(/\/$/, ''), secret: secretIn.value.trim() };
        S.currentConvId = convSel.value;
        S.currentUserPersonaId = null; // 換會話要重抓
        await roche.storage.set('toyRelaySettings', S.settings);
        await roche.storage.set('toyConversationId', S.currentConvId);
        roche.ui.toast('已儲存');
      };

      btnToggle.onclick = () => {
        if (S.isMonitoring) { stopMonitor(); roche.ui.toast('監控已停止'); }
        else {
          if (!S.settings.relay || !S.settings.secret) { roche.ui.toast('請先填中繼網址與密語'); return; }
          if (!convSel.value) { roche.ui.toast('請先選擇要監控的會話'); return; }
          S.currentConvId = convSel.value;
          roche.storage.set('toyConversationId', S.currentConvId);
          startMonitor();
          roche.ui.toast('後台監控已啟動');
        }
      };

      btnStop.onclick = async () => { await hardStop(); roche.ui.toast('已送出停止'); };
    },

    unmount(container) {
      // 只清 UI 回呼，不停監控（後台續跑）
      S.onStatusChange = null;
      if (container) container.replaceChildren();
    }
  };

  // ============================================================
  // 註冊
  // ============================================================
  window.RochePlugin.register({
    id: 'ai-toy-relay',
    name: 'AI 玩具控制（中繼版）',
    version: '1.0.0',
    description: '監控聊天指令，經 Cloudflare 中繼由 iPad 控制玩具',
    author: 'you',
    apps: [pluginApp]
  });

  // 除錯接口（可選，console 輸入 __toyRelay 查看狀態）
  window.__toyRelay = { state: S, parseCommand, sendRelay, startMonitor, stopMonitor, hardStop };
})();
