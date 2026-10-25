(function () {
  "use strict";

  const rules = globalThis.DamaOnlineRules;
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const storage = { name: "damaPinoy.onlineName", room: "damaPinoy.onlineRoom",
    guest: "damaPinoy.onlineGuestId" };
  const squares = Array.from({ length: 8 }, () => []);
  const ui = {};
  let client = null;
  let clientPromise = null;
  let guestPromise = null;
  let userId = null;
  let channel = null;
  let timer = 0;
  let state = null;
  let selection = null;
  let busy = false;
  let synced = null;
  let connected = false;
  let opponentPresent = false;
  let currentEpoch = 0;
  let focused = { row: 5, col: 0 };

  function getStored(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  function setStored(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* optional */ }
  }
  function clearStored(key) {
    try { localStorage.removeItem(key); } catch (error) { /* optional */ }
  }
  function setStatus(text, error = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle("is-error", error);
  }
  function isOnline() { return navigator.onLine !== false; }
  function config() { return globalThis.DAMA_ONLINE_CONFIG || {}; }
  function localColor() {
    if (!state) return null;
    return state.room.hostId === userId ? state.room.hostColor : state.room.guestColor;
  }
  function opponentName() {
    if (!state) return "Opponent";
    return state.room.hostId === userId ? state.room.guestName : state.room.hostName;
  }
  function localName() {
    if (!state) return "You";
    return state.room.hostId === userId ? state.room.hostName : state.room.guestName;
  }
  function same(a, b) { return a && b && a.row === b.row && a.col === b.col; }
  function sameBoard(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  async function loadClient() {
    if (client) return client;
    if (!isOnline()) throw new Error("Online Multiplayer needs an internet connection.");
    const settings = config();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(settings.supabaseUrl || "") ||
        !settings.publishableKey) {
      throw new Error("Online Multiplayer is not configured yet. Set the Supabase URL and publishable key.");
    }
    if (!clientPromise) {
      clientPromise = (async function () {
        if (!globalThis.supabase?.createClient) {
          await new Promise(function (resolve, reject) {
            const tag = document.createElement("script");
            tag.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.0/dist/umd/supabase.min.js";
            tag.onload = resolve;
            tag.onerror = function () { reject(new Error("Could not load the online service.")); };
            document.head.appendChild(tag);
          });
        }
        if (!globalThis.supabase?.createClient) throw new Error("Could not load the online service.");
        client = globalThis.supabase.createClient(settings.supabaseUrl.replace(/\/$/, ""),
          settings.publishableKey, { auth: { persistSession: true,
            autoRefreshToken: true, detectSessionInUrl: false } });
        return client;
      })().catch(function (error) { clientPromise = null; throw error; });
    }
    return clientPromise;
  }

  function ensureGuest() {
    if (guestPromise) return guestPromise;
    guestPromise = (async function () {
      const service = await loadClient();
      let { data, error } = await service.auth.getSession();
      if (error) throw new Error("Could not restore your guest session.");
      if (!data.session) {
        ({ data, error } = await service.auth.signInAnonymously());
        if (error || !data.user) throw new Error("Could not start a guest session.");
        userId = data.user.id;
      } else {
        userId = data.session.user.id;
      }
      setStored(storage.guest, userId);
      return service;
    })().finally(function () { guestPromise = null; });
    return guestPromise;
  }

  async function request(action, details = {}) {
    const service = await ensureGuest();
    const session = (await service.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error("Guest session expired. Try again.");
    const settings = config();
    const response = await fetch(settings.supabaseUrl.replace(/\/$/, "") +
      "/functions/v1/online-room", {
      method: "POST",
      headers: { "Content-Type": "application/json",
        apikey: settings.publishableKey,
        Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ action, ...details }),
    });
    let result;
    try { result = await response.json(); } catch (error) {
      throw new Error("Online service is unavailable. Try again.");
    }
    if (!response.ok || !result?.state) {
      throw new Error(typeof result?.error === "string" ? result.error :
        "Online service is unavailable. Try again.");
    }
    return result.state;
  }

  // Broadcast messages are hints only; every state is fetched from PostgreSQL.
  // Verify every move again with the same Dama rules before displaying it.
  function verifyState(next) {
    if (!next?.room || !Array.isArray(next.moves) ||
        (next.room.hostId !== userId && next.room.guestId !== userId) ||
        !["waiting", "active", "finished", "closed"].includes(next.room.status) ||
        !new RegExp("^[" + alphabet + "]{6}$").test(next.room.code) ||
        !["R", "B"].includes(next.room.hostColor) ||
        next.room.guestColor !== (next.room.hostColor === "R" ? "B" : "R")) {
      throw new Error("Synchronization warning. Room state is invalid.");
    }
    if (!next.game) {
      if (next.moves.length || next.room.status === "active") {
        throw new Error("Synchronization warning. Room state is invalid.");
      }
      return;
    }
    if (!rules.validBoard(next.game.board) ||
        next.game.moveCount !== next.moves.length ||
        (next.room.status !== "closed" && next.room.status !== next.game.status)) {
      throw new Error("Synchronization warning. Board state is invalid.");
    }
    let board = rules.initialBoard();
    let turn = "R";
    let quiet = 0;
    let result = null;
    for (let index = 0; index < next.moves.length; index++) {
      const move = next.moves[index];
      if (result || move.number !== index + 1 || move.playerColor !== turn) {
        throw new Error("Synchronization warning. Move sequence is invalid.");
      }
      let applied;
      try { applied = rules.applyMove(board, turn, quiet, move); } catch (error) {
        throw new Error("Synchronization warning. Move sequence is invalid.");
      }
      board = applied.board;
      quiet = applied.quietPlies;
      turn = applied.nextTurn;
      result = applied.result;
    }
    if (!sameBoard(board, next.game.board) || quiet !== next.game.quietPlies ||
        turn !== next.room.turn ||
        (next.game.status === "finished") !== Boolean(result) ||
        (result && next.game.winner !== result.winner)) {
      throw new Error("Synchronization warning. Board state is invalid.");
    }
  }

  function clearSelection() { selection = null; }

  function setScreen() {
    const room = state?.room;
    const waiting = room?.status === "waiting";
    const playing = Boolean(state?.game) && room?.status !== "closed";
    ui.entry.hidden = Boolean(waiting || playing);
    ui.waiting.hidden = !waiting;
    ui.match.hidden = !playing;
    if (room?.status === "closed") {
      setStatus("Room closed because your opponent left or disconnected. You can create or join another room.");
    } else if (waiting) {
      setStatus("Waiting for opponent…");
    } else if (playing) {
      setStatus(state.game.status === "finished" ? "Game complete. Request a rematch to play again." :
        state.room.turn === localColor() ? "Your turn." : "Opponent’s turn.");
    }
  }

  function renderBoard() {
    if (!state?.game || ui.match.hidden) return;
    const own = localColor();
    const flipped = own === "B";
    ui.board.dataset.orientation = flipped ? "blue" : "red";
    ui.board.setAttribute("aria-label", "Online Dama board. " +
      (flipped ? "Blue" : "Red") + " pieces at the bottom.");
    ui.board.setAttribute("aria-busy", busy ? "true" : "false");
    for (let index = 0; index < 8; index++) {
      ui.files.children[index].textContent = String.fromCharCode(65 + (flipped ? 7 - index : index));
      ui.ranks.children[index].textContent = String(flipped ? index + 1 : 8 - index);
    }
    const position = selection?.preview || state.game.board;
    const legal = !busy && state.room.status === "active" &&
      state.room.turn === own ? rules.legalMoves(state.game.board, own) : [];
    const choices = selection ? selection.candidates : [];
    const stepIndex = selection ? selection.path.length : 0;
    const available = choices.map((move) => move.path[stepIndex]);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = squares[row][col];
        const piece = position[row][col];
        const dark = (row + col) % 2 === 1;
        square.style.order = flipped ? String(63 - row * 8 - col) : "";
        square.className = "square " + (dark ? "dark" : "light");
        if (selection && same(selection.position, { row, col })) square.classList.add("is-selected");
        if (available.some((target) => same(target, { row, col }))) {
          square.classList.add(choices[0]?.captures.length ? "is-capture" : "is-move");
        }
        if (!selection && legal.some((move) => same(move.from, { row, col })) &&
            legal[0]?.captures.length) square.classList.add("is-mandatory");
        square.replaceChildren();
        if (piece) {
          const disc = document.createElement("span");
          disc.className = "piece piece--" + (piece[0] === "R" ? "red" : "blue") +
            (piece.length === 2 ? " piece--dama" : "");
          if (piece.length === 2) {
            const crown = document.createElement("span");
            crown.className = "crown";
            crown.textContent = "♛";
            crown.setAttribute("aria-hidden", "true");
            disc.appendChild(crown);
          }
          disc.setAttribute("aria-hidden", "true");
          square.appendChild(disc);
        }
        square.setAttribute("aria-label", String.fromCharCode(65 + col) + (8 - row) +
          (piece ? ", " + (piece[0] === "R" ? "Red" : "Blue") +
            (piece.length === 2 ? " Dama" : " piece") : ", empty") +
          (!dark ? ", unplayable" : ""));
        square.setAttribute("aria-disabled", state.room.turn !== own || busy ? "true" : "false");
        square.tabIndex = focused.row === row && focused.col === col ? 0 : -1;
      }
    }
  }

  function render() {
    setScreen();
    if (!state) return;
    const room = state.room;
    ui.roomCode.textContent = room.code;
    ui.gameCode.textContent = room.code;
    ui.waitingPlayers.textContent = room.guestName ?
      room.hostName + " (Red) vs " + room.guestName + " (Blue)" :
      room.hostName + " is waiting for an opponent…";
    if (!state.game) return;
    const own = localColor();
    ui.gamePlayers.textContent = localName() + " (" + (own === "R" ? "Red" : "Blue") +
      ") vs " + opponentName() + " (" + (own === "R" ? "Blue" : "Red") + ")";
    const finished = state.game.status === "finished";
    ui.turn.textContent = finished ? "Game over" :
      room.turn === own ? "Your turn" : "Opponent’s turn";
    ui.result.hidden = !finished;
    if (finished) {
      ui.result.textContent = state.game.winner === null ? "Game drawn." :
        state.game.winner === own ? "You win!" : opponentName() + " wins!";
    }
    const requested = room.hostId === userId ? room.rematchHost : room.rematchGuest;
    ui.rematch.hidden = !finished;
    ui.rematch.disabled = requested || busy;
    ui.rematch.textContent = requested ? "Waiting for opponent…" : "Request Rematch";
    ui.history.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const move of state.moves) {
      const item = document.createElement("li");
      item.className = "move move--" + (move.playerColor === "R" ? "red" : "blue");
      const path = [move.from, ...move.path];
      const notation = path.map((step) => String.fromCharCode(97 + step.col) + (8 - step.row))
        .join(move.captures.length ? "x" : "-") + (move.promoted ? "=D" : "");
      item.textContent = move.number + ". " + (move.playerColor === "R" ? "Red" : "Blue") +
        " " + notation;
      fragment.appendChild(item);
    }
    ui.history.appendChild(fragment);
    renderBoard();
  }

  async function applyState(next) {
    verifyState(next);
    if (state?.room.id === next.room.id &&
        next.room.version < state.room.version) return;
    if (state?.game?.id !== next.game?.id ||
        state?.game?.moveCount !== next.game?.moveCount) clearSelection();
    state = next;
    if (state.room.status === "closed") {
      clearStored(storage.room);
      await stopChannel();
    } else {
      setStored(storage.room, state.room.id);
      if (!channel) await watchRoom(state.room.id);
    }
    render();
  }

  async function synchronize() {
    if (!state || synced || !isOnline()) return synced;
    const id = state.room.id;
    synced = request("state", { roomId: id }).then(applyState).catch(function (error) {
      setStatus(error.message || "Synchronization warning. Retrying…", true);
    }).finally(function () { synced = null; });
    return synced;
  }

  async function stopChannel() {
    currentEpoch += 1;
    if (timer) { clearInterval(timer); timer = 0; }
    const previous = channel;
    channel = null;
    connected = false;
    opponentPresent = false;
    if (previous && client) {
      try { await client.removeChannel(previous); } catch (error) { /* disconnected */ }
    }
  }

  function notify(event) {
    if (!channel || !connected) return;
    channel.send({ type: "broadcast", event,
      payload: { roomId: state?.room.id, roomCode: state?.room.code,
        guestId: userId, guestName: localName(), version: state?.room.version } })
      .catch(function () { /* the heartbeat will reconcile */ });
  }

  async function watchRoom(roomId) {
    if (!client || channel) return;
    const epoch = ++currentEpoch;
    const subscription = client.channel("room:" + roomId, {
      config: { private: true, broadcast: { self: false }, presence: { key: userId } },
    });
    channel = subscription;
    const events = ["player-joined", "game-started", "move-made", "game-ended",
      "rematch-requested", "rematch-accepted", "player-left", "room-closed"];
    for (const event of events) {
      subscription.on("broadcast", { event }, function () { synchronize(); });
    }
    subscription.on("presence", { event: "sync" }, function () {
      if (epoch !== currentEpoch || !state?.room.guestId) return;
      const other = state.room.hostId === userId ? state.room.guestId : state.room.hostId;
      const present = Boolean(subscription.presenceState()[other]?.length);
      if (opponentPresent && !present) {
        ui.connection.textContent = "Opponent disconnected. Waiting for them to reconnect…";
      } else if (!opponentPresent && present) {
        ui.connection.textContent = "Opponent connected.";
      }
      opponentPresent = present;
    });
    subscription.subscribe(async function (status) {
      if (epoch !== currentEpoch) return;
      connected = status === "SUBSCRIBED";
      ui.connection.textContent = connected ? "Connected" : "Reconnecting…";
      if (connected) {
        try { await subscription.track({ guestId: userId }); } catch (error) { /* retry */ }
        synchronize();
      }
    });
    timer = setInterval(synchronize, 15000);
  }

  function previewHop(target, candidate) {
    const current = selection.position;
    const piece = selection.preview[current.row][current.col];
    const index = selection.path.length;
    const captured = candidate.captures[index];
    selection.preview[current.row][current.col] = null;
    if (captured) selection.preview[captured.row][captured.col] = null;
    selection.preview[target.row][target.col] = piece;
    selection.position = target;
    selection.path.push(target);
    selection.candidates = selection.candidates.filter((move) =>
      selection.path.every((step, stepIndex) => same(step, move.path[stepIndex])));
  }

  async function submitMove(move) {
    if (busy || !state?.game) return;
    busy = true;
    let rejected = false;
    render();
    try {
      const next = await request("move", {
        roomId: state.room.id, gameId: state.game.id,
        moveNumber: state.game.moveCount + 1,
        move: { from: move.from, path: move.path,
          captures: move.captures, promoted: move.promoted },
      });
      clearSelection();
      await applyState(next);
      notify(next.game.status === "finished" ? "game-ended" : "move-made");
    } catch (error) {
      rejected = true;
      clearSelection();
      await synchronize();
    } finally {
      busy = false;
      render();
      if (rejected) setStatus("Move was not accepted. Board resynchronized; please try again.", true);
    }
  }

  function clickSquare(row, col) {
    focused = { row, col };
    if (busy || !state?.game || state.room.status !== "active" ||
        state.room.turn !== localColor()) return;
    const position = { row, col };
    const moves = rules.legalMoves(state.game.board, localColor());
    if (selection) {
      const index = selection.path.length;
      const matching = selection.candidates.filter((move) => same(move.path[index], position));
      if (matching.length) {
        previewHop(position, matching[0]);
        const complete = selection.candidates.find((move) => move.path.length === selection.path.length);
        if (complete) submitMove(complete);
        else renderBoard();
        return;
      }
      if (selection.path.length) return; // A capture chain cannot be abandoned.
      if (same(selection.from, position)) { clearSelection(); renderBoard(); return; }
    }
    const available = moves.filter((move) => same(move.from, position));
    if (!available.length) return;
    selection = { from: position, position, path: [], candidates: available,
      preview: state.game.board.map((line) => line.slice()) };
    renderBoard();
  }

  function boardKeydown(event) {
    const direction = localColor() === "B" ? -1 : 1;
    const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0],
      ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focused = event.key === "Home"
        ? { row: direction === -1 ? 7 : 0, col: direction === -1 ? 7 : 0 }
        : { row: direction === -1 ? 0 : 7, col: direction === -1 ? 0 : 7 };
    } else if (deltas[event.key]) {
      event.preventDefault();
      focused = { row: Math.max(0, Math.min(7, focused.row + deltas[event.key][0] * direction)),
        col: Math.max(0, Math.min(7, focused.col + deltas[event.key][1] * direction)) };
    } else return;
    renderBoard();
    squares[focused.row][focused.col].focus({ preventScroll: true });
  }

  async function enterRoom(action) {
    if (busy) return;
    const name = ui.name.value.trim();
    if (!name || name.length > 20) {
      setStatus("Enter a guest name of up to 20 characters.", true);
      ui.name.focus();
      return;
    }
    const code = ui.code.value.trim().toUpperCase();
    if (action === "join" && (!new RegExp("^[" + alphabet + "]{6}$").test(code))) {
      setStatus("Enter a valid six-character room code.", true);
      ui.code.focus();
      return;
    }
    busy = true;
    ui.create.disabled = true;
    ui.join.disabled = true;
    setStatus(action === "create" ? "Creating room…" : "Joining room…");
    try {
      const next = await request(action, { name, code });
      setStored(storage.name, name);
      await applyState(next);
      if (action === "join") notify("player-joined");
    } catch (error) {
      setStatus(error.message || "Could not connect. Try again.", true);
    } finally {
      busy = false;
      ui.create.disabled = false;
      ui.join.disabled = false;
    }
  }

  async function leaveRoom() {
    if (busy) return;
    if (!state) { globalThis.DamaPinoyApp.showScreen("screen-title"); return; }
    busy = true;
    notify("player-left");
    try { await request("leave", { roomId: state.room.id }); } catch (error) {
      setStatus("Could not notify the room. It will expire after inactivity.", true);
    }
    await stopChannel();
    clearStored(storage.room);
    state = null;
    clearSelection();
    busy = false;
    globalThis.DamaPinoyApp.showScreen("screen-title");
  }

  async function rematch() {
    if (busy || !state || state.game?.status !== "finished") return;
    busy = true;
    ui.rematch.disabled = true;
    try {
      const next = await request("rematch", { roomId: state.room.id });
      await applyState(next);
      notify(next.game.status === "active" ? "rematch-accepted" : "rematch-requested");
      if (next.game.status !== "active") setStatus("Rematch requested. Waiting for opponent…");
    } catch (error) { setStatus(error.message || "Rematch unavailable.", true); }
    finally { busy = false; render(); }
  }

  async function openOnline() {
    globalThis.DamaPinoyApp.showScreen("screen-online");
    if (!isOnline()) {
      setStatus("Online Multiplayer needs an internet connection. Local play still works offline.", true);
      return;
    }
    try {
      await ensureGuest();
      const saved = getStored(storage.room);
      if (saved) await applyState(await request("state", { roomId: saved }));
      else setStatus("Enter a guest name to create or join a room.");
    } catch (error) {
      clearStored(storage.room);
      setStatus(error.message || "Online service is unavailable.", true);
    }
  }

  function init() {
    ui.status = document.getElementById("online-status");
    ui.entry = document.getElementById("online-entry");
    ui.waiting = document.getElementById("online-waiting");
    ui.match = document.getElementById("online-match");
    ui.name = document.getElementById("online-name");
    ui.code = document.getElementById("online-code");
    ui.create = document.getElementById("btn-create-room");
    ui.join = document.getElementById("btn-join-room");
    ui.roomCode = document.getElementById("online-room-code");
    ui.gameCode = document.getElementById("online-game-code");
    ui.waitingPlayers = document.getElementById("online-waiting-players");
    ui.connection = document.getElementById("online-connection");
    ui.turn = document.getElementById("online-turn");
    ui.gamePlayers = document.getElementById("online-game-players");
    ui.result = document.getElementById("online-result");
    ui.rematch = document.getElementById("btn-online-rematch");
    ui.history = document.getElementById("online-history");
    ui.board = document.getElementById("online-board");
    ui.files = document.getElementById("online-files");
    ui.ranks = document.getElementById("online-ranks");
    ui.name.value = getStored(storage.name) || "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = document.createElement("button");
        square.type = "button";
        square.className = "square";
        square.addEventListener("click", () => clickSquare(row, col));
        square.addEventListener("focus", () => { focused = { row, col }; });
        ui.board.appendChild(square);
        squares[row][col] = square;
      }
    }
    ui.board.addEventListener("keydown", boardKeydown);
    document.getElementById("btn-online").addEventListener("click", openOnline);
    document.getElementById("btn-online-back").addEventListener("click", function () {
      globalThis.DamaPinoyApp.showScreen("screen-title");
    });
    ui.create.addEventListener("click", () => enterRoom("create"));
    ui.join.addEventListener("click", () => enterRoom("join"));
    ui.code.addEventListener("input", function () {
      ui.code.value = ui.code.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    });
    document.getElementById("btn-copy-room").addEventListener("click", async function () {
      try {
        await navigator.clipboard.writeText(state.room.code);
        setStatus("Room code copied.");
      } catch (error) { setStatus("Could not copy. Select the room code to share it.", true); }
    });
    document.getElementById("btn-online-wait-leave").addEventListener("click", leaveRoom);
    document.getElementById("btn-online-leave").addEventListener("click", leaveRoom);
    ui.rematch.addEventListener("click", rematch);
    window.addEventListener("online", function () { if (state) synchronize(); });
    window.addEventListener("offline", function () {
      if (state) ui.connection.textContent = "Offline. Waiting to reconnect…";
    });
  }

  if (globalThis.__DAMA_TEST__) {
    globalThis.DamaPinoyOnlineTest = {
      openOnline, verifyState, applyState, clickSquare,
      getState: () => state, getSelection: () => selection,
      getUserId: () => userId, synchronize,
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
