(function () {
  "use strict";

  const rules = globalThis.DamaOnlineRules;
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const FORMAT_LABELS = {
    single: "Single Game",
    bestOfThree: "Best of 3",
    bestOfFive: "Best of 5",
    bestOfNine: "Best of 9",
  };
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
  let syncing = null;
  let syncAgain = false;
  let pendingMove = false;
  let pendingPrevious = null;
  let animatedMoveKey = null;
  let connected = false;
  let opponentPresent = false;
  let currentEpoch = 0;
  let focused = { row: 5, col: 0 };
  let savedCandidate = null;

  function isSpectator() { return state?.role === "spectator"; }

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
  function opposite(color) { return color === "R" ? "B" : "R"; }
  function isColor(color) { return color === "R" || color === "B"; }
  function formatLimit(format) { return rules.MATCH_GAME_LIMITS[format] || 0; }
  function currentColors() {
    if (!state) return null;
    return state.game
      ? { host: state.game.hostColor, guest: state.game.guestColor }
      : { host: state.room.hostColor, guest: state.room.guestColor };
  }
  function localColor() {
    if (!state || isSpectator()) return null;
    const colors = currentColors();
    return state.room.hostId === userId ? colors.host : colors.guest;
  }
  function colorName(color) { return color === "R" ? "Red" : "Blue"; }
  function formatLabel(room) { return FORMAT_LABELS[room.seriesFormat] || "Match"; }
  function nextActionLabel(room) {
    if (room.status === "finished") {
      return room.seriesFormat === "single" ? "Rematch" : "New Series";
    }
    return "Next Game";
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

  async function request(action, details = {}, raw = false) {
    const service = await ensureGuest();
    const session = (await service.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error("Guest session expired. Try again.");
    const settings = config();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(settings.supabaseUrl.replace(/\/$/, "") +
        "/functions/v1/online-room", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json",
          apikey: settings.publishableKey,
          Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ action, ...details }),
      });
    } catch (error) {
      throw new Error("Online service timed out. Check your connection and try again.");
    } finally {
      clearTimeout(timeout);
    }
    let result;
    try { result = await response.json(); } catch (error) {
      throw new Error("Online service is unavailable. Try again.");
    }
    if (!response.ok || (!raw && !result?.state && !result?.left)) {
      throw new Error(typeof result?.error === "string" ? result.error :
        "Online service is unavailable. Try again.");
    }
    return raw ? result : result.state;
  }

  // Broadcast messages are hints only; every state is fetched from PostgreSQL.
  // Verify every move again with the same Dama rules before displaying it.
  function verifyState(next) {
    const room = next?.room;
    if (!room || !Array.isArray(next.moves) ||
        (room.hostId !== userId && room.guestId !== userId && next.role !== "spectator") ||
        !["waiting", "active", "finished", "closed"].includes(room.status) ||
        !new RegExp("^[" + alphabet + "]{6}$").test(room.code) ||
        !isColor(room.hostColor) || room.guestColor !== opposite(room.hostColor) ||
        !Object.prototype.hasOwnProperty.call(rules.MATCH_GAME_LIMITS, room.seriesFormat) ||
        !Number.isInteger(room.seriesNumber) || room.seriesNumber < 1 ||
        !Number.isInteger(room.gameNumber) || room.gameNumber < 1 ||
        !Number.isInteger(room.hostScore) || room.hostScore < 0 ||
        !Number.isInteger(room.guestScore) || room.guestScore < 0 ||
        !Number.isInteger(room.draws) || room.draws < 0 ||
        !isColor(room.turn) ||
        !(room.matchWinnerId === null || room.matchWinnerId === room.hostId ||
          room.matchWinnerId === room.guestId)) {
      throw new Error("Synchronization warning. Room state is invalid.");
    }
    if (next.role === "spectator" && (!Array.isArray(next.spectators) ||
        !next.spectators.some((s) => s.id === userId) ||
        room.hostId === userId || room.guestId === userId)) {
      throw new Error("Synchronization warning. Spectator state is invalid.");
    }
    const limit = formatLimit(room.seriesFormat);
    const total = room.hostScore + room.guestScore + room.draws;
    if (room.gameNumber > limit || room.hostScore > limit ||
        room.guestScore > limit || room.draws > limit || total > limit ||
        (room.status === "active" && room.matchWinnerId !== null)) {
      throw new Error("Synchronization warning. Series state is invalid.");
    }
    if (!next.game) {
      if (next.moves.length || (room.status !== "waiting" && room.status !== "closed") ||
          room.gameNumber !== 1 || total !== 0) {
        throw new Error("Synchronization warning. Room state is invalid.");
      }
      return;
    }
    const game = next.game;
    if (!rules.validBoard(game.board) ||
        !Number.isInteger(game.moveCount) || game.moveCount !== next.moves.length ||
        !Number.isInteger(game.seriesNumber) || game.seriesNumber !== room.seriesNumber ||
        !Number.isInteger(game.gameNumber) || game.gameNumber !== room.gameNumber ||
        !isColor(game.hostColor) || game.guestColor !== opposite(game.hostColor) ||
        !["active", "finished"].includes(game.status) || room.status === "waiting") {
      throw new Error("Synchronization warning. Board state is invalid.");
    }
    const expectedHost = game.gameNumber % 2 === 1 ? room.hostColor : room.guestColor;
    if (game.hostColor !== expectedHost ||
        (room.status === "finished" && game.status !== "finished") ||
        (game.status === "finished" && total !== room.gameNumber) ||
        (game.status === "active" && total !== room.gameNumber - 1)) {
      throw new Error("Synchronization warning. Game state is invalid.");
    }
    const majority = Math.floor(limit / 2) + 1;
    if (room.status === "active" && game.status === "finished" &&
        (room.hostScore >= majority || room.guestScore >= majority || total >= limit)) {
      throw new Error("Synchronization warning. Match state is invalid.");
    }
    if (room.status === "finished") {
      const expectedWinner = room.hostScore > room.guestScore ? room.hostId :
        room.guestScore > room.hostScore ? room.guestId : null;
      if ((total < limit && room.hostScore < majority && room.guestScore < majority) ||
          room.matchWinnerId !== expectedWinner) {
        throw new Error("Synchronization warning. Match state is invalid.");
      }
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
    if (!sameBoard(board, game.board) || quiet !== game.quietPlies ||
        turn !== room.turn ||
        (game.status === "finished") !== Boolean(result) ||
        (result ? game.winner !== result.winner || game.reason !== result.reason
          : game.winner !== null)) {
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
    ui.replaysPanel.hidden = Boolean(waiting || playing);
    if (room?.status === "closed") {
      setStatus("Room closed because your opponent left or disconnected. You can create or join another room.");
    } else if (waiting) {
      setStatus("Waiting for opponent…");
    } else if (playing) {
      if (state.game.status === "finished") {
        if (room.status === "finished") {
          setStatus(room.seriesFormat === "single"
            ? "Game complete. Request a rematch to play again."
            : "Match complete. Request a new series to play again.");
        } else {
          setStatus("Game complete. Request the next game to continue the series.");
        }
      } else {
        setStatus(isSpectator() ? "Spectating · " + colorName(room.turn) + " to move." :
          room.turn === localColor() ? "Your turn." : "Opponent’s turn.");
      }
    }
  }

  function animateLastMove(move) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = squares[move.from.row]?.[move.from.col];
    const to = squares[move.to.row]?.[move.to.col];
    const piece = to?.querySelector(".piece");
    if (!from || !to || !piece) return;
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    piece.style.setProperty("--arrive-x", (start.left - end.left) + "px");
    piece.style.setProperty("--arrive-y", (start.top - end.top) + "px");
    piece.classList.add("piece--arrive");
    piece.addEventListener("animationend", function () {
      piece.classList.remove("piece--arrive");
      piece.style.removeProperty("--arrive-x");
      piece.style.removeProperty("--arrive-y");
    }, { once: true });
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
    const canPlay = !isSpectator() && !busy && state.room.status === "active" &&
      state.game.status === "active" && state.room.turn === own;
    const legal = canPlay ? rules.legalMoves(state.game.board, own) : [];
    const choices = selection ? selection.candidates : [];
    const stepIndex = selection ? selection.path.length : 0;
    const available = choices.map((move) => move.path[stepIndex]);
    const last = state.moves[state.moves.length - 1];
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const square = squares[row][col];
        const piece = position[row][col];
        const dark = (row + col) % 2 === 1;
        const squareAt = { row, col };
        square.style.order = flipped ? String(63 - row * 8 - col) : "";
        square.className = "square " + (dark ? "dark" : "light");
        if (selection && same(selection.position, squareAt)) square.classList.add("is-selected");
        if (available.some((target) => same(target, squareAt))) {
          square.classList.add(choices[0]?.captures.length ? "is-capture" : "is-move");
        }
        if (!selection && legal.some((move) => same(move.from, squareAt)) &&
            legal[0]?.captures.length) square.classList.add("is-mandatory");
        if (last && same(last.from, squareAt)) square.classList.add("is-last-from");
        if (last && same(last.to, squareAt)) {
          square.classList.add("is-last");
          if (last.promoted) square.classList.add("is-promoting");
        }
        if (last && last.captures.some((target) => same(target, squareAt))) {
          square.classList.add("is-capture-flash");
        }
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
        square.setAttribute("aria-disabled", canPlay ? "false" : "true");
        square.tabIndex = focused.row === row && focused.col === col ? 0 : -1;
      }
    }
    if (last) {
      const key = state.game.id + ":" + last.number;
      if (key !== animatedMoveKey) {
        animatedMoveKey = key;
        animateLastMove(last);
      }
    }
  }

  function render() {
    setScreen();
    if (!state) return;
    const room = state.room;
    const hostColor = colorName(room.hostColor);
    const guestColor = colorName(room.guestColor);
    ui.roomCode.textContent = room.code;
    ui.gameCode.textContent = room.code;
    ui.waitingPlayers.textContent = room.guestName ?
      room.hostName + " (" + hostColor + ") vs " + room.guestName + " (" + guestColor + ")" :
      room.hostName + " is waiting for an opponent…";
    ui.waitingOptions.textContent = formatLabel(room) + " · " +
      room.hostName + " plays " + hostColor + " in Game 1 · Red opens";
    if (!state.game) return;
    const own = localColor();
    const opponent = opposite(own);
    ui.gamePlayers.textContent = localName() + " (" + colorName(own) +
      ") vs " + opponentName() + " (" + colorName(opponent) + ")";
    ui.spectatorBadge.hidden = !isSpectator();
    if (isSpectator()) ui.gamePlayers.textContent = room.hostName + " (" +
      colorName(state.game.hostColor) + ") vs " + room.guestName + " (" + colorName(state.game.guestColor) + ")";
    const finished = state.game.status === "finished";
    const matchOver = room.status === "finished";
    ui.turn.textContent = finished ? (matchOver ? "Match over" : "Game over") :
      room.turn === own ? "Your turn" : "Opponent’s turn";
    if (isSpectator() && !finished) ui.turn.textContent = colorName(room.turn) + " to move";
    ui.series.hidden = false;
    ui.seriesFormat.textContent = formatLabel(room) + " · Game " + room.gameNumber +
      " of " + formatLimit(room.seriesFormat);
    ui.seriesScore.textContent = room.hostName + " " + room.hostScore + " – " +
      room.guestScore + " " + room.guestName +
      (room.draws ? " · " + room.draws + (room.draws === 1 ? " draw" : " draws") : "");
    ui.result.hidden = !finished;
    if (finished) {
      ui.result.textContent = state.game.winner === null ? "Game drawn." :
        state.game.winner === own ? "You win this game!" : opponentName() + " wins this game!";
      if (isSpectator() && state.game.winner) ui.result.textContent =
        (state.game.winner === state.game.hostColor ? room.hostName : room.guestName) + " wins this game!";
    }
    ui.matchResult.hidden = !(finished && matchOver);
    if (finished && matchOver) {
      ui.matchResult.textContent = room.matchWinnerId === null ? "Match drawn." :
        room.matchWinnerId === userId ? "You win the match!" :
          opponentName() + " wins the match!";
      if (isSpectator() && room.matchWinnerId) ui.matchResult.textContent =
        (room.matchWinnerId === room.hostId ? room.hostName : room.guestName) + " wins the match!";
    }
    const requested = room.hostId === userId ? room.rematchHost : room.rematchGuest;
    ui.rematch.hidden = isSpectator() || !finished || room.status === "closed";
    ui.replayActions.hidden = !finished || room.status === "closed";
    ui.spectators.textContent = "Spectators (" + (state.spectators || []).length + "/5): " +
      ((state.spectators || []).map((s) => s.name).join(", ") || "None");
    const last = state.moves[state.moves.length - 1];
    ui.lastMove.textContent = last ? "Last move: " + colorName(last.playerColor) + " " +
      [last.from, ...last.path].map((s) => String.fromCharCode(97 + s.col) + (8 - s.row))
        .join(last.captures.length ? "×" : "–") + (last.promoted ? " · promoted to Dama" : "") : "No moves yet.";
    ui.rematch.disabled = requested || busy;
    ui.rematch.textContent = requested ? "Waiting for opponent…" :
      "Request " + nextActionLabel(room);
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

  async function applyState(next, force = false) {
    if (pendingMove && !force) return;
    verifyState(next);
    if (state?.room.id === next.room.id &&
        next.room.version < state.room.version) return;
    if (state?.room.id !== next.room.id || state?.game?.id !== next.game?.id) {
      animatedMoveKey = null;
    }
    if (state?.game?.id !== next.game?.id ||
        state?.game?.moveCount !== next.game?.moveCount) clearSelection();
    state = next;
    ui.rejoin.hidden = true;
    savedCandidate = null;
    if (state.room.status === "closed") {
      clearStored(storage.room);
      await stopChannel();
    } else {
      setStored(storage.room, state.room.id);
      setStored("damaPinoy.onlineRoomCode", state.room.code);
      if (!channel) await watchRoom(state.room.id);
    }
    render();
  }

  async function synchronize() {
    if (!state || !isOnline() || pendingMove) return;
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    const id = state.room.id;
    const epoch = currentEpoch;
    syncing = (async function () {
      do {
        syncAgain = false;
        try {
          const next = await request("state", { roomId: id });
          if (state?.room.id !== id || epoch !== currentEpoch) return;
          await applyState(next);
        } catch (error) {
          if (state?.room.id === id && epoch === currentEpoch) {
            setStatus(error.message || "Synchronization warning. Retrying…", true);
          }
        }
      } while (syncAgain && state?.room.id === id && isOnline() && !pendingMove);
    })().finally(function () { syncing = null; });
    return syncing;
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
    if (isSpectator() || !channel || !connected) return;
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
      "rematch-requested", "rematch-accepted", "player-left", "opponent-disconnected", "room-closed"];
    for (const event of events) {
      subscription.on("broadcast", { event }, function () { synchronize(); });
    }
    subscription.on("presence", { event: "sync" }, function () {
      if (epoch !== currentEpoch || !state?.room.guestId || isSpectator()) return;
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
    timer = setInterval(synchronize, 5000);
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

  function applyOptimisticMove(applied) {
    const room = state.room;
    let hostScore = room.hostScore;
    let guestScore = room.guestScore;
    let draws = room.draws;
    let status = "active";
    let matchWinnerId = null;
    if (applied.result) {
      hostScore += applied.result.winner === state.game.hostColor ? 1 : 0;
      guestScore += applied.result.winner === state.game.guestColor ? 1 : 0;
      draws += applied.result.winner === null ? 1 : 0;
      const limit = formatLimit(room.seriesFormat);
      const majority = Math.floor(limit / 2) + 1;
      if (hostScore >= majority || guestScore >= majority ||
          hostScore + guestScore + draws >= limit) {
        status = "finished";
        matchWinnerId = hostScore > guestScore ? room.hostId :
          guestScore > hostScore ? room.guestId : null;
      }
    }
    state = {
      ...state,
      room: { ...room, turn: applied.nextTurn, hostScore, guestScore, draws,
        status, matchWinnerId },
      game: { ...state.game, board: applied.board, quietPlies: applied.quietPlies,
        moveCount: state.game.moveCount + 1,
        status: applied.result ? "finished" : "active",
        winner: applied.result ? applied.result.winner : null,
        reason: applied.result ? applied.result.reason : null },
      moves: state.moves.concat({ ...applied.move, number: state.game.moveCount + 1 }),
    };
  }

  async function submitMove(move) {
    if (isSpectator() || busy || !state?.game || state.room.status !== "active" ||
        state.game.status !== "active") return;
    let applied;
    try {
      applied = rules.applyMove(state.game.board, localColor(), state.game.quietPlies, move);
    } catch (error) {
      clearSelection();
      render();
      return;
    }
    const expectedCount = state.game.moveCount;
    busy = true;
    pendingPrevious = state;
    pendingMove = true;
    applyOptimisticMove(applied);
    clearSelection();
    render();
    let rejected = false;
    try {
      const next = await request("move", {
        roomId: state.room.id, gameId: state.game.id,
        moveNumber: expectedCount + 1,
        move: { from: move.from, path: move.path,
          captures: move.captures, promoted: move.promoted },
      });
      pendingMove = false;
      await applyState(next, true);
      pendingPrevious = null;
      notify(next.game.status === "finished" ? "game-ended" : "move-made");
    } catch (error) {
      rejected = true;
      state = pendingPrevious || state;
      pendingMove = false;
      pendingPrevious = null;
      clearSelection();
      render();
      await synchronize();
    } finally {
      busy = false;
      render();
      if (rejected) setStatus("Move was not accepted. Board resynchronized; please try again.", true);
    }
  }

  function clickSquare(row, col) {
    focused = { row, col };
    if (isSpectator() || busy || !state?.game || state.room.status !== "active" ||
        state.game.status !== "active" || state.room.turn !== localColor()) return;
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
    if (busy || savedCandidate) return;
    const name = ui.name.value.trim();
    if (!name || name.length > 20) {
      setStatus("Enter a guest name of up to 20 characters.", true);
      ui.name.focus();
      return;
    }
    const code = ui.code.value.trim().toUpperCase();
    if (action !== "create" && (!new RegExp("^[" + alphabet + "]{6}$").test(code))) {
      setStatus("Enter a valid six-character room code.", true);
      ui.code.focus();
      return;
    }
    const color = document.querySelector('input[name="online-color"]:checked')?.value || "R";
    const format = document.querySelector('input[name="online-format"]:checked')?.value || "single";
    if (action === "create" && (!isColor(color) || !formatLimit(format))) {
      setStatus("Choose a valid color and match format.", true);
      return;
    }
    busy = true;
    ui.create.disabled = true;
    ui.join.disabled = true;
    ui.spectate.disabled = true;
    setStatus(action === "create" ? "Creating room…" : "Joining room…");
    try {
      const next = await request(action, action === "create"
        ? { name, color, format } : { name, code });
      setStored(storage.name, name);
      await applyState(next);
      if (action === "join") notify("player-joined");
    } catch (error) {
      setStatus(error.message || "Could not connect. Try again.", true);
    } finally {
      busy = false;
      ui.create.disabled = false;
      ui.join.disabled = false;
      ui.spectate.disabled = false;
      render();
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
    clearStored("damaPinoy.onlineRoomCode");
    state = null;
    clearSelection();
    pendingMove = false;
    pendingPrevious = null;
    animatedMoveKey = null;
    busy = false;
    render();
    globalThis.DamaPinoyApp.showScreen("screen-title");
  }

  async function rejoinSaved(leave = false) {
    if (busy || !savedCandidate) return;
    busy = true;
    ui.rejoinButton.disabled = ui.rejoinLeave.disabled = true;
    const id = savedCandidate;
    try {
      const next = await request("state", { roomId: id });
      verifyState(next);
      if (leave) {
        await request("leave", { roomId: id });
        clearStored(storage.room);
        clearStored("damaPinoy.onlineRoomCode");
        savedCandidate = null;
        ui.rejoin.hidden = true;
        setStatus("Left the saved room.");
      } else {
        await applyState(next);
      }
    } catch (error) {
      setStatus("Could not restore the saved room. It may have expired. " + error.message, true);
      // Leaving also provides an escape when an expired membership is no longer readable.
      if (leave) {
        clearStored(storage.room);
        clearStored("damaPinoy.onlineRoomCode");
        savedCandidate = null;
        ui.rejoin.hidden = true;
      }
    } finally {
      busy = false;
      ui.rejoinButton.disabled = ui.rejoinLeave.disabled = false;
      ui.create.disabled = ui.join.disabled = ui.spectate.disabled = Boolean(savedCandidate);
      if (state) render();
    }
  }

  function replayFile(record) {
    const formats = { single: "single", bestOfThree: "bestOf3", bestOfFive: "bestOf5", bestOfNine: "bestOf9" };
    if (!record || !Array.isArray(record.moves) || !record.moves.length ||
        record.moves.length !== record.total_moves || !formats[record.series_format] ||
        !isColor(record.host_color) || record.guest_color !== opposite(record.host_color)) {
      throw new Error("Invalid online replay.");
    }
    let board = rules.initialBoard();
    let turn = "R";
    let quiet = 0;
    let result = null;
    const moves = record.moves.map((move, index) => {
      if (result || move.number !== index + 1 || move.playerColor !== turn) throw new Error("Invalid replay sequence.");
      const applied = rules.applyMove(board, turn, quiet, move);
      board = applied.board;
      quiet = applied.quietPlies;
      turn = applied.nextTurn;
      result = applied.result;
      return { player: move.playerColor === record.host_color ? "P1" : "P2",
        from: move.from, to: move.to, piece: move.pieceType,
        captures: move.captures, promoted: move.promoted };
    });
    if (!result || record.winner_color !== result.winner || record.result_reason !== result.reason ||
        record.result !== (result.winner === null ? "draw" : result.winner === record.host_color ? "host" : "guest")) {
      throw new Error("Invalid replay result.");
    }
    const winner = record.result === "host" ? "P1" : record.result === "guest" ? "P2" : "draw";
    const players = { P1: record.host_name, P2: record.guest_name };
    const view = userId === record.host_guest_id ? record.host_view :
      userId === record.guest_guest_id ? record.guest_view : "red-bottom";
    return { format: "dama-pinoy-replay", version: 1, exportedAt: new Date(record.created_at).toISOString(),
      players, moves, game: { mode: "online", seriesFormat: formats[record.series_format],
        gameNumber: record.game_number, seriesScore: { P1: record.host_score, P2: record.guest_score },
        aiDifficulty: null, result: winner, winner: winner === "draw" ? null : players[winner],
        resultDetail: "Online · Series " + record.series_number + " · " + record.result_reason,
        totalMoves: moves.length, startingPlayer: "red", view,
        colors: { P1: record.host_color === "R" ? "red" : "blue", P2: record.guest_color === "R" ? "red" : "blue" } } };
  }

  async function viewOnlineReplay(details, download = false) {
    try {
      if (!isOnline()) throw new Error("Online replays require an internet connection.");
      const result = await request("replay", details, true);
      if (!globalThis.DamaPinoyApp.openOnlineReplay(replayFile(result.replay), download)) {
        throw new Error("Could not export this replay.");
      }
    } catch (error) {
      setStatus(error.message || "Could not load online replay.", true);
      ui.replaysStatus.textContent = error.message || "Could not load online replay.";
    }
  }

  async function loadReplays() {
    ui.replaysButton.disabled = true;
    ui.replaysStatus.textContent = "Loading online replays…";
    try {
      if (!isOnline()) throw new Error("Online replays require an internet connection. Local replay viewing still works offline.");
      const result = await request("replays", {}, true);
      if (!Array.isArray(result.replays) || result.replays.length > 20) throw new Error("Invalid replay list.");
      ui.replaysList.replaceChildren();
      for (const replay of result.replays) {
        const ownHost = replay.host_guest_id === userId;
        if (!ownHost && replay.guest_guest_id !== userId) throw new Error("Invalid replay ownership.");
        const item = document.createElement("li");
        const label = document.createElement("p");
        const outcome = replay.result === "draw" ? "Draw" :
          (replay.result === "host") === ownHost ? "Win" : "Loss";
        label.textContent = new Date(replay.created_at).toLocaleString() + " · " +
          (ownHost ? replay.guest_name : replay.host_name) + " · " +
          (FORMAT_LABELS[replay.series_format] || "Match") + " · Series " + replay.series_number +
          ", Game " + replay.game_number + " · " + outcome;
        item.appendChild(label);
        for (const download of [false, true]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn btn--ghost";
          button.textContent = download ? "Export Replay" : "View Replay";
          button.addEventListener("click", () => viewOnlineReplay({ replayId: replay.id }, download));
          item.appendChild(button);
        }
        ui.replaysList.appendChild(item);
      }
      ui.replaysStatus.textContent = result.replays.length ? "Showing your latest " + result.replays.length + " replays." :
        "No online replays yet. Finish an online game to record one.";
    } catch (error) {
      ui.replaysStatus.textContent = error.message || "Could not load online replays. Try again.";
    } finally { ui.replaysButton.disabled = false; }
  }

  async function rematch() {
    if (isSpectator() || busy || !state || state.game?.status !== "finished" ||
        !["active", "finished"].includes(state.room.status)) return;
    const label = nextActionLabel(state.room);
    busy = true;
    ui.rematch.disabled = true;
    try {
      const next = await request("rematch", { roomId: state.room.id });
      await applyState(next);
      notify(next.game.status === "active" ? "rematch-accepted" : "rematch-requested");
      if (next.game.status !== "active") {
        setStatus(label + " requested. Waiting for opponent…");
      }
    } catch (error) { setStatus(error.message || "Rematch unavailable.", true); }
    finally { busy = false; render(); }
  }

  async function openOnline() {
    globalThis.DamaPinoyApp.showScreen("screen-online");
    render();
    if (!isOnline()) {
      setStatus("Online Multiplayer needs an internet connection. Local play still works offline.", true);
      return;
    }
    try {
      await ensureGuest();
      const saved = getStored(storage.room);
      if (state && state.room.status !== "closed") { render(); return; }
      if (saved) {
        savedCandidate = saved;
        ui.rejoin.hidden = false;
        ui.rejoinText.textContent = "You have a saved room" +
          (getStored("damaPinoy.onlineRoomCode") ? ": " + getStored("damaPinoy.onlineRoomCode") : "") + ". Rejoin?";
        ui.create.disabled = ui.join.disabled = ui.spectate.disabled = true;
        setStatus("You have a saved room. Rejoin or leave it before starting another.");
      } else setStatus("Enter a guest name to create or join a room.");
    } catch (error) {
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
    ui.spectate = document.getElementById("btn-spectate-room");
    ui.rejoin = document.getElementById("online-rejoin");
    ui.rejoinText = document.getElementById("online-rejoin-text");
    ui.rejoinButton = document.getElementById("btn-online-rejoin");
    ui.rejoinLeave = document.getElementById("btn-online-rejoin-leave");
    ui.spectatorBadge = document.getElementById("online-spectator-badge");
    ui.spectators = document.getElementById("online-spectators");
    ui.lastMove = document.getElementById("online-last-move");
    ui.replayActions = document.getElementById("online-replay-actions");
    ui.replaysButton = document.getElementById("btn-online-replays");
    ui.replaysStatus = document.getElementById("online-replays-status");
    ui.replaysList = document.getElementById("online-replays-list");
    ui.replaysPanel = document.getElementById("online-replays");
    ui.roomCode = document.getElementById("online-room-code");
    ui.gameCode = document.getElementById("online-game-code");
    ui.waitingPlayers = document.getElementById("online-waiting-players");
    ui.waitingOptions = document.getElementById("online-waiting-options");
    ui.connection = document.getElementById("online-connection");
    ui.turn = document.getElementById("online-turn");
    ui.gamePlayers = document.getElementById("online-game-players");
    ui.series = document.getElementById("online-series");
    ui.seriesFormat = document.getElementById("online-series-format");
    ui.seriesScore = document.getElementById("online-series-score");
    ui.result = document.getElementById("online-result");
    ui.matchResult = document.getElementById("online-match-result");
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
    ui.spectate.addEventListener("click", () => enterRoom("spectate"));
    ui.rejoinButton.addEventListener("click", () => rejoinSaved());
    ui.rejoinLeave.addEventListener("click", () => rejoinSaved(true));
    ui.replaysButton.addEventListener("click", loadReplays);
    document.getElementById("btn-online-view-replay").addEventListener("click", () => {
      if (state?.game?.status === "finished") viewOnlineReplay({ gameId: state.game.id });
    });
    document.getElementById("btn-online-export-replay").addEventListener("click", () => {
      if (state?.game?.status === "finished") viewOnlineReplay({ gameId: state.game.id }, true);
    });
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
    window.addEventListener("focus", function () { if (state) synchronize(); });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state) synchronize();
    });
  }

  if (globalThis.__DAMA_TEST__) {
    globalThis.DamaPinoyOnlineTest = {
      openOnline, verifyState, applyState, clickSquare,
      getState: () => state, getSelection: () => selection,
      getUserId: () => userId, synchronize,
      replayFile, loadReplays, rejoinSaved,
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
