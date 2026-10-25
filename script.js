(function () {
  "use strict";

  const BOARD_SIZE = 8;
  const DIAGONAL_DIRECTIONS = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
  const DRAW_PLY_LIMIT = 200; // 100 moves by each player
  const PROMOTION_ROW = { R: 0, B: 7 };
  const COLOR_NAMES = { R: "Red", B: "Blue" };
  const DEFAULT_NAMES = { P1: "Player 1", P2: "Player 2" };
  const PLAYER_IDS = ["P1", "P2"];
  const HUMAN_DEFAULT_LABEL = "You";
  const AI_NAME = "Computer";
  const START_FOCUS = { row: 5, col: 0 };
  const THEMES = ["wood", "night", "light"];
  const THEME_COLORS = { wood: "#452617", night: "#0a1018", light: "#f3f5f8" };
  const GAME_MODES = ["twoPlayer", "vsComputer"];
  const AI_DIFFICULTIES = ["easy", "medium", "hard"];
  const MATCH_GAME_LIMITS = {
    single: 1,
    bestOfThree: 3,
    bestOfFive: 5,
    bestOfNine: 9,
  };
  const MATCH_FORMATS = Object.keys(MATCH_GAME_LIMITS);
  const STORAGE_KEYS = {
    names: "damaPinoy.names",
    scores: "damaPinoy.scores",
    sound: "damaPinoy.sound",
    theme: "damaPinoy.theme",
    mode: "damaPinoy.mode",
    difficulty: "damaPinoy.difficulty",
    format: "damaPinoy.format",
    startColor: "damaPinoy.startColor",
    lastReplay: "damaPinoy.lastReplay",
    stats: "damaPinoyStatsV1",
  };
  const STATS_VERSION = 1;
  const STATS_MODE_KEYS = ["twoPlayer", "vsEasy", "vsMedium", "vsHard"];
  const STATS_MODE_UI_KEYS = {
    twoPlayer: "two-player",
    vsEasy: "vs-easy",
    vsMedium: "vs-medium",
    vsHard: "vs-hard",
  };
  const STATS_SERIES_KEYS = {
    bestOfThree: "bestOf3",
    bestOfFive: "bestOf5",
    bestOfNine: "bestOf9",
  };
  const STATS_SERIES_UI_KEYS = {
    bestOf3: "best-of-3",
    bestOf5: "best-of-5",
    bestOf9: "best-of-9",
  };
  const MOVE_ANIM_MS = 220;
  const CAPTURE_ANIM_MS = 300;
  const PROMOTION_ANIM_MS = 520;
  const AI_MIN_THINK_MS = 550;
  const AI_HARD_TIME_MS = 850;
  const AI_HARD_MAX_DEPTH = 4;
  const AI_YIELD_INTERVAL = 250;
  const REPLAY_VERSION = 2;
  const REPLAY_STEP_MS = 900;
  const REPLAY_FILE_VERSION = 1;
  const REPLAY_FILE_FORMAT = "dama-pinoy-replay";
  const REPLAY_FILE_MAX_BYTES = 5 * 1024 * 1024;
  const REPLAY_FILE_FORMATS = {
    single: "single",
    bestOfThree: "bestOf3",
    bestOfFive: "bestOf5",
    bestOfNine: "bestOf9",
  };
  const REPLAY_INTERNAL_FORMATS = {
    single: "single",
    bestOf3: "bestOfThree",
    bestOf5: "bestOfFive",
    bestOf9: "bestOfNine",
  };
  const START_FOCUS_BY_PLAYER = {
    R: { row: 5, col: 0 },
    B: { row: 2, col: 1 },
  };

  let board = [];
  let currentPlayer = "R";
  let selectedPiece = null;
  let legalMoves = [];
  let mandatoryCapturePieces = [];
  let movesWithoutCaptureOrPromotion = 0;
  let gameOver = false;

  // Capture selection state: the set of maximum-length chains that remain
  // reachable from the piece currently being moved, plus the path taken so far.
  let turnBestChains = [];
  let activeChainSet = [];
  let chainPath = [];
  let turnCapturedSquares = [];
  let lastMove = null;
  let focusedSquare = { ...START_FOCUS };

  // Version 1.1 state
  let moveHistory = [];
  let gameHistory = [];
  let turnStartState = null;
  let gameResult = null;
  let names = { ...DEFAULT_NAMES };
  let scores = { P1: 0, P2: 0 };
  let soundEnabled = false;
  let currentTheme = "wood";
  let isAnimating = false;
  let epoch = 0;
  let revealTimer = 0;
  let pendingConfirm = null;
  let confirmOpener = null;
  let audioContext = null;
  let sfxBus = null;
  let sfxBusContext = null;

  // Version 1.2 state
  let gameMode = "twoPlayer";
  let aiDifficulty = "medium";
  let aiThinking = false;
  let aiApplying = false;
  let aiTimer = 0;
  let aiToken = 0;

  let matchFormat = "single";
  let seriesScores = { P1: 0, P2: 0 };
  let currentGameNumber = 1;
  let matchWinner = null;
  let startingPlayer = "R";
  let gameOneColor = "R";
  let playerColors = { P1: "R", P2: "B" };
  let matchDifficulty = "medium";
  let lastReplay = null;
  let replayState = null;
  let replayTimer = 0;
  let replayStatusTimer = 0;

  let stats = createEmptyStats();
  let statsReturnScreen = "screen-title";
  let statsOpen = false;
  let statsPendingEnd = false;
  let statsRecordedForGame = false;
  let seriesStatsRecorded = false;

  const dom = {};
  const squareEls = [];
  const replaySquareEls = [];

  /* ------------------------------------------------------------------ */
  /* Storage                                                            */
  /* ------------------------------------------------------------------ */

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      /* Storage may be unavailable; the game still works without it. */
    }
  }

  function loadPreferences() {
    const storedTheme = storageGet(STORAGE_KEYS.theme);
    if (THEMES.indexOf(storedTheme) !== -1) currentTheme = storedTheme;
    document.documentElement.setAttribute("data-theme", currentTheme);

    soundEnabled = storageGet(STORAGE_KEYS.sound) === "on";

    const storedMode = storageGet(STORAGE_KEYS.mode);
    if (GAME_MODES.indexOf(storedMode) !== -1) gameMode = storedMode;

    const storedDifficulty = storageGet(STORAGE_KEYS.difficulty);
    if (AI_DIFFICULTIES.indexOf(storedDifficulty) !== -1) {
      aiDifficulty = storedDifficulty;
    }

    const storedFormat = storageGet(STORAGE_KEYS.format);
    if (MATCH_FORMATS.indexOf(storedFormat) !== -1) {
      matchFormat = storedFormat;
    }
    const storedColor = storageGet(STORAGE_KEYS.startColor);
    if (storedColor === "R" || storedColor === "B") gameOneColor = storedColor;

    const storedNames = storageGet(STORAGE_KEYS.names);
    if (storedNames) {
      try {
        const parsed = JSON.parse(storedNames);
        if (parsed && typeof parsed === "object") {
          for (const id of PLAYER_IDS) {
            const legacy = id === "P1" ? "R" : "B";
            const value = typeof parsed[id] === "string" ? parsed[id] : parsed[legacy];
            if (typeof value === "string") names[id] = value.slice(0, 20);
          }
          if (typeof parsed.P1 !== "string" && typeof parsed.R === "string") {
            saveNames();
          }
        }
      } catch (error) {
        /* Ignore malformed saved data. */
      }
    }

    const storedScores = storageGet(STORAGE_KEYS.scores);
    if (storedScores) {
      try {
        const parsed = JSON.parse(storedScores);
        if (parsed && typeof parsed === "object") {
          for (const id of PLAYER_IDS) {
            const legacy = id === "P1" ? "R" : "B";
            const value = parsed[id] === undefined ? parsed[legacy] : parsed[id];
            if (Number.isFinite(value) && value >= 0) {
              scores[id] = Math.min(99999, Math.floor(value));
            }
          }
          if (parsed.P1 === undefined && parsed.R !== undefined) saveScores();
        }
      } catch (error) {
        /* Ignore malformed saved data. */
      }
    }
  }

  function saveNames() {
    storageSet(STORAGE_KEYS.names, JSON.stringify(names));
  }

  function saveScores() {
    storageSet(STORAGE_KEYS.scores, JSON.stringify(scores));
  }

  function saveGameSettings() {
    storageSet(STORAGE_KEYS.mode, gameMode);
    storageSet(STORAGE_KEYS.difficulty, aiDifficulty);
    storageSet(STORAGE_KEYS.format, matchFormat);
    storageSet(STORAGE_KEYS.startColor, gameOneColor);
  }

  function createStatsBucket() {
    return {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      currentWinStreak: 0,
      longestWinStreak: 0,
    };
  }

  function createEmptyStats() {
    const overall = createStatsBucket();
    overall.capturesFor = 0;
    overall.capturesAgainst = 0;
    overall.totalMoves = 0;
    return {
      version: STATS_VERSION,
      overall,
      modes: {
        twoPlayer: createStatsBucket(),
        vsEasy: createStatsBucket(),
        vsMedium: createStatsBucket(),
        vsHard: createStatsBucket(),
      },
      series: {
        bestOf3: { seriesPlayed: 0, seriesWon: 0, seriesLost: 0 },
        bestOf5: { seriesPlayed: 0, seriesWon: 0, seriesLost: 0 },
        bestOf9: { seriesPlayed: 0, seriesWon: 0, seriesLost: 0 },
      },
    };
  }

  function statsCount(value) {
    return Number.isFinite(value) && value >= 0
      ? Math.min(999999999, Math.floor(value))
      : 0;
  }

  function sanitizeStatsBucket(source, target) {
    if (!source || typeof source !== "object") return target;
    target.gamesPlayed = statsCount(source.gamesPlayed);
    target.wins = statsCount(source.wins);
    target.losses = statsCount(source.losses);
    target.draws = statsCount(source.draws);
    target.currentWinStreak = statsCount(source.currentWinStreak);
    target.longestWinStreak = statsCount(source.longestWinStreak);
    return target;
  }

  function sanitizeStats(source) {
    const result = createEmptyStats();
    if (!source || typeof source !== "object" || source.version !== STATS_VERSION) {
      return result;
    }

    sanitizeStatsBucket(source.overall, result.overall);
    if (source.overall && typeof source.overall === "object") {
      result.overall.capturesFor = statsCount(source.overall.capturesFor);
      result.overall.capturesAgainst = statsCount(source.overall.capturesAgainst);
      result.overall.totalMoves = statsCount(source.overall.totalMoves);
    }

    if (source.modes && typeof source.modes === "object") {
      for (const key of STATS_MODE_KEYS) {
        sanitizeStatsBucket(source.modes[key], result.modes[key]);
      }
    }

    if (source.series && typeof source.series === "object") {
      for (const key of Object.keys(result.series)) {
        const stored = source.series[key];
        if (!stored || typeof stored !== "object") continue;
        result.series[key].seriesPlayed = statsCount(stored.seriesPlayed);
        result.series[key].seriesWon = statsCount(stored.seriesWon);
        result.series[key].seriesLost = statsCount(stored.seriesLost);
      }
    }

    return result;
  }

  function loadStats() {
    const stored = storageGet(STORAGE_KEYS.stats);
    if (!stored) {
      stats = createEmptyStats();
      return;
    }
    try {
      stats = sanitizeStats(JSON.parse(stored));
    } catch (error) {
      stats = createEmptyStats();
      storageRemove(STORAGE_KEYS.stats);
    }
  }

  function saveStats() {
    return storageSet(STORAGE_KEYS.stats, JSON.stringify(stats));
  }

  function cloneStats(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function calculateWinRate(wins, losses, draws) {
    const total = wins + losses + draws;
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.round((wins / total) * 100);
  }

  function calculateSeriesWinRate(won, played) {
    if (!Number.isFinite(played) || played <= 0) return 0;
    return Math.round((won / played) * 100);
  }

  function formatAverageMoves(totalMoves, gamesPlayed) {
    if (!Number.isFinite(gamesPlayed) || gamesPlayed <= 0) return "0.0";
    return (totalMoves / gamesPlayed).toFixed(1);
  }

  function statsModeKey() {
    if (gameMode === "twoPlayer") return "twoPlayer";
    if (matchDifficulty === "easy") return "vsEasy";
    if (matchDifficulty === "hard") return "vsHard";
    return "vsMedium";
  }

  function applyStatsOutcome(bucket, outcome) {
    bucket.gamesPlayed += 1;
    if (outcome === "win") {
      bucket.wins += 1;
      bucket.currentWinStreak += 1;
      bucket.longestWinStreak = Math.max(
        bucket.longestWinStreak,
        bucket.currentWinStreak
      );
      return;
    }
    if (outcome === "loss") {
      bucket.losses += 1;
    } else {
      bucket.draws += 1;
    }
    bucket.currentWinStreak = 0;
  }

  function recordGameResult(result) {
    if (statsRecordedForGame) return;
    const humanColor = humanSide();
    let outcome = "draw";
    if (result && result.winner === humanColor) outcome = "win";
    else if (result && result.winner) outcome = "loss";

    let capturesFor = 0;
    let capturesAgainst = 0;
    for (const record of moveHistory) {
      const captured = Array.isArray(record.capturedSquares)
        ? record.capturedSquares.length
        : 0;
      if (record.player === humanColor) capturesFor += captured;
      else capturesAgainst += captured;
    }

    stats.overall.capturesFor += capturesFor;
    stats.overall.capturesAgainst += capturesAgainst;
    stats.overall.totalMoves += moveHistory.length;
    applyStatsOutcome(stats.overall, outcome);

    const modeKey = statsModeKey();
    applyStatsOutcome(stats.modes[modeKey], outcome);
    statsRecordedForGame = true;
    saveStats();
    renderStats();
  }

  function recordSeriesResult() {
    if (!isSeriesMatch() || !matchWinner || seriesStatsRecorded) return;
    const key = STATS_SERIES_KEYS[matchFormat];
    if (!key || !stats.series[key]) return;
    const bucket = stats.series[key];
    bucket.seriesPlayed += 1;
    if (matchWinner === "P1") bucket.seriesWon += 1;
    else if (matchWinner === "P2") bucket.seriesLost += 1;
    seriesStatsRecorded = true;
    saveStats();
    renderStats();
  }

  function renderStats() {
    if (!dom.statValues) return;
    const signedIn = Boolean(globalThis.DamaPinoyAccount?.isLoggedIn());
    const source = document.getElementById("stats-source");
    const localNote = document.getElementById("stats-local-note");
    if (source) source.textContent = signedIn ? "Your private, server-validated online results across devices." :
      "Your completed games and series on this device.";
    if (localNote) localNote.hidden = signedIn;
    if (dom.btnResetStats) dom.btnResetStats.hidden = signedIn;
    if (signedIn) {
      if (dom.statsContent) dom.statsContent.hidden = true;
      if (dom.statsEmpty) dom.statsEmpty.hidden = true;
      if (dom.btnResetStats) dom.btnResetStats.disabled = true;
      globalThis.DamaPinoyAccount.renderStats();
      return;
    }
    const accountStats = document.getElementById("account-stats");
    if (accountStats) accountStats.hidden = true;
    const overall = stats.overall;
    const values = {
      "overall-games": overall.gamesPlayed,
      "overall-wins": overall.wins,
      "overall-losses": overall.losses,
      "overall-draws": overall.draws,
      "overall-win-rate":
        calculateWinRate(overall.wins, overall.losses, overall.draws) + "%",
      "overall-current-streak": overall.currentWinStreak,
      "overall-longest-streak": overall.longestWinStreak,
      "captures-for": overall.capturesFor,
      "captures-against": overall.capturesAgainst,
      "average-moves": formatAverageMoves(
        overall.totalMoves,
        overall.gamesPlayed
      ),
    };

    for (const modeKey of STATS_MODE_KEYS) {
      const mode = stats.modes[modeKey];
      const uiKey = STATS_MODE_UI_KEYS[modeKey];
      values["mode-" + uiKey + "-games"] = mode.gamesPlayed;
      values["mode-" + uiKey + "-wins"] = mode.wins;
      values["mode-" + uiKey + "-losses"] = mode.losses;
      values["mode-" + uiKey + "-draws"] = mode.draws;
      values["mode-" + uiKey + "-win-rate"] =
        calculateWinRate(mode.wins, mode.losses, mode.draws) + "%";
      values["mode-" + uiKey + "-current-streak"] = mode.currentWinStreak;
      values["mode-" + uiKey + "-longest-streak"] = mode.longestWinStreak;
    }

    for (const seriesKey of Object.keys(stats.series)) {
      const series = stats.series[seriesKey];
      const uiKey = STATS_SERIES_UI_KEYS[seriesKey];
      values["series-" + uiKey + "-played"] = series.seriesPlayed;
      values["series-" + uiKey + "-won"] = series.seriesWon;
      values["series-" + uiKey + "-lost"] = series.seriesLost;
      values["series-" + uiKey + "-win-rate"] =
        calculateSeriesWinRate(series.seriesWon, series.seriesPlayed) + "%";
    }

    for (const key of Object.keys(values)) {
      const element = dom.statValues[key];
      if (element) element.textContent = String(values[key]);
    }

    const hasGames = overall.gamesPlayed > 0;
    if (dom.statsContent) dom.statsContent.hidden = !hasGames;
    if (dom.statsEmpty) dom.statsEmpty.hidden = hasGames;
    if (dom.btnResetStats) {
      dom.btnResetStats.disabled = !hasGames;
      dom.btnResetStats.setAttribute("aria-disabled", hasGames ? "false" : "true");
    }
  }

  function isStatsScreenOpen() {
    const screen = document.getElementById("screen-stats");
    return Boolean(screen && !screen.hidden);
  }

  function updateStatsBackLabel() {
    if (!dom.btnStatsBack) return;
    dom.btnStatsBack.textContent =
      statsReturnScreen === "screen-game" ? "Back to Game" : "Back to Menu";
  }

  function openStats(returnScreen) {
    statsReturnScreen =
      returnScreen === "screen-game" ? "screen-game" : "screen-title";
    statsOpen = true;
    statsPendingEnd = false;
    renderStats();
    updateStatsBackLabel();
    showScreen("screen-stats");
  }

  function closeStats() {
    statsOpen = false;
    if (statsPendingEnd) {
      statsPendingEnd = false;
      showScreen("screen-end");
      return;
    }
    const target = statsReturnScreen;
    showScreen(target);
    const opener = target === "screen-game" ? dom.btnGameStats : dom.btnStats;
    if (opener && typeof opener.focus === "function") {
      opener.focus({ preventScroll: true });
    }
  }

  function resetStats() {
    stats = createEmptyStats();
    saveStats();
    renderStats();
    announce("Statistics reset.");
    if (dom.btnStatsBack) dom.btnStatsBack.focus({ preventScroll: true });
  }

  function requestResetStats() {
    openConfirm({
      title: "Reset statistics?",
      message:
        "This clears all recorded games, series, and streaks. Player names, theme, sound, saved replay, active game, and all-time win counters are kept.",
      confirmLabel: "Reset Statistics",
      onConfirm: resetStats,
    });
  }

  function handleStatsKeydown(event) {
    if (!isStatsScreenOpen() || event.key !== "Escape") return;
    if (dom.confirmDialog && dom.confirmDialog.open) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    closeStats();
  }

  function isBoardShape(value) {
    if (!Array.isArray(value) || value.length !== BOARD_SIZE) return false;
    for (const line of value) {
      if (!Array.isArray(line) || line.length !== BOARD_SIZE) return false;
      for (const cell of line) {
        if (cell !== null && ["R", "B", "RD", "BD"].indexOf(cell) === -1) {
          return false;
        }
      }
    }
    return true;
  }

  function isReplayCoordinate(value) {
    return Boolean(
      value &&
        Number.isInteger(value.row) &&
        Number.isInteger(value.col) &&
        value.row >= 0 &&
        value.row < BOARD_SIZE &&
        value.col >= 0 &&
        value.col < BOARD_SIZE
    );
  }

  function isReplayRecord(value) {
    return Boolean(
      value &&
        (value.player === "R" || value.player === "B") &&
        (value.piece === null ||
          value.piece === undefined ||
          ["R", "B", "RD", "BD"].indexOf(value.piece) !== -1) &&
        isReplayCoordinate(value.from) &&
        isReplayCoordinate(value.to) &&
        Array.isArray(value.path) &&
        value.path.every(isReplayCoordinate) &&
        Array.isArray(value.capturedSquares) &&
        value.capturedSquares.every(isReplayCoordinate) &&
        typeof value.notation === "string"
    );
  }

  function isReplayData(value) {
    return Boolean(
      value &&
        (value.version === 1 || value.version === REPLAY_VERSION) &&
        (value.mode === "twoPlayer" || value.mode === "vsComputer" || value.mode === "online") &&
        MATCH_FORMATS.indexOf(value.format) !== -1 &&
        Number.isInteger(value.gameNumber) &&
        value.gameNumber >= 1 &&
        value.gameNumber <= matchGameLimit(value.format) &&
        isBoardShape(value.initialBoard) &&
        isBoardShape(value.finalBoard) &&
        Array.isArray(value.moves) &&
        value.moves.length <= 5000 &&
        value.moves.every(isReplayRecord) &&
        value.players &&
        typeof value.players.R === "string" &&
        typeof value.players.B === "string" &&
        (value.version === 1 ||
          (value.colors &&
            (value.colors.P1 === "R" || value.colors.P1 === "B") &&
            value.colors.P2 === opposite(value.colors.P1) &&
            value.startingPlayer === "R" &&
            value.series &&
            Number.isInteger(value.series.P1) &&
            Number.isInteger(value.series.P2))) &&
        value.result &&
        typeof value.result.title === "string" &&
        typeof value.result.detail === "string" &&
        (value.result.winner === "R" ||
          value.result.winner === "B" ||
          value.result.winner === null)
    );
  }

  function updateLastReplayButton() {
    if (!dom.btnLastReplay) return;
    dom.btnLastReplay.hidden = !lastReplay;
    if (dom.btnExportEnd) dom.btnExportEnd.hidden = !lastReplay;
  }

  function loadSavedReplay() {
    lastReplay = null;
    const stored = storageGet(STORAGE_KEYS.lastReplay);
    if (!stored) {
      updateLastReplayButton();
      return;
    }
    try {
      const parsed = JSON.parse(stored);
      if (isReplayData(parsed)) {
        lastReplay = parsed;
      } else {
        storageRemove(STORAGE_KEYS.lastReplay);
      }
    } catch (error) {
      storageRemove(STORAGE_KEYS.lastReplay);
    }
    updateLastReplayButton();
  }

  function saveLastReplay(replay) {
    if (!isReplayData(replay)) return;
    lastReplay = replay;
    storageSet(STORAGE_KEYS.lastReplay, JSON.stringify(replay));
    updateLastReplayButton();
  }

  function buildReplayData(result) {
    const replayPlayers = {
      R: displayName("R"),
      B: displayName("B"),
    };
    const gameLabel = "Game " + currentGameNumber;
    let resultTitle;
    if (result.winner) {
      const label = replayPlayers[result.winner];
      const verb = label === HUMAN_DEFAULT_LABEL ? "win" : "wins";
      resultTitle =
        label +
        " " +
        verb +
        (isSeriesMatch() ? " " + gameLabel : "");
    } else {
      resultTitle = isSeriesMatch() ? gameLabel + " drawn" : "Draw";
    }

    return {
      version: REPLAY_VERSION,
      createdAt: new Date().toISOString(),
      mode: gameMode,
      format: matchFormat,
      difficulty: isVsComputer() ? matchDifficulty : null,
      gameNumber: currentGameNumber,
      startingPlayer,
      colors: { P1: playerColors.P1, P2: playerColors.P2 },
      players: replayPlayers,
      series: { P1: seriesScores.P1, P2: seriesScores.P2 },
      initialBoard: createInitialBoard(),
      finalBoard: board.map(function (line) {
        return line.slice();
      }),
      moves: moveHistory.map(cloneMoveRecord),
      result: {
        winner: result.winner,
        title: resultTitle,
        detail: result.detail,
      },
    };
  }

  /* The downloaded format is independent of the stored replay versions. */
  function serializeReplay(replay, exportedAt = new Date().toISOString(), viewOverride) {
    if (!isReplayData(replay)) throw new Error("Invalid saved replay");
    const colors = replay.version === 1
      ? { P1: "R", P2: "B" }
      : replay.colors;
    const owner = { [colors.P1]: "P1", [colors.P2]: "P2" };
    const players = {
      P1: replay.players[colors.P1],
      P2: replay.players[colors.P2],
    };
    const winner = replay.result.winner
      ? owner[replay.result.winner]
      : "draw";
    let position = replay.initialBoard.map(function (line) {
      return line.slice();
    });
    if (JSON.stringify(position) !== JSON.stringify(createInitialBoard())) {
      throw new Error("Invalid saved replay");
    }

    const moves = replay.moves.map(function (record) {
      const piece = position[record.from.row][record.from.col];
      if (!piece || pieceColor(piece) !== record.player) {
        throw new Error("Invalid saved replay");
      }
      const move = {
        player: owner[record.player],
        from: cloneSquare(record.from),
        to: cloneSquare(record.to),
        piece: isDama(piece) ? "dama" : "normal",
        captures: record.capturedSquares.map(cloneSquare),
        promoted: record.promoted === true,
      };
      position = applyReplayRecord(position, record);
      return move;
    });
    if (JSON.stringify(position) !== JSON.stringify(replay.finalBoard)) {
      throw new Error("Invalid saved replay");
    }
    const file = {
      format: REPLAY_FILE_FORMAT,
      version: REPLAY_FILE_VERSION,
      exportedAt,
      game: {
        mode: replay.mode,
        seriesFormat: REPLAY_FILE_FORMATS[replay.format],
        gameNumber: replay.gameNumber,
        seriesScore: replay.version === 1
          ? { P1: 0, P2: 0 }
          : { P1: replay.series.P1, P2: replay.series.P2 },
        aiDifficulty: replay.mode === "vsComputer" ? replay.difficulty : null,
        result: winner,
        winner: winner === "draw" ? null : players[winner],
        resultDetail: replay.result.detail,
        totalMoves: moves.length,
        startingPlayer: "red",
        colors: {
          P1: colors.P1 === "R" ? "red" : "blue",
          P2: colors.P2 === "R" ? "red" : "blue",
        },
        view: viewOverride || (replay.version === 1 || colors.P1 === "R"
          ? "red-bottom"
          : "blue-bottom"),
      },
      players,
      moves,
    };
    deserializeReplay(file); // A download must also pass the importer.
    return file;
  }

  function replayFileObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function replayFileText(value, limit) {
    return typeof value === "string" &&
      value.trim().length > 0 && value.length <= limit;
  }

  function invalidReplayFile() {
    throw new Error("Invalid replay file");
  }

  function deserializeReplay(file) {
    if (!replayFileObject(file) || file.format !== REPLAY_FILE_FORMAT ||
        file.version !== REPLAY_FILE_VERSION ||
        !replayFileText(file.exportedAt, 24) ||
        !replayFileObject(file.game) || !replayFileObject(file.players) ||
        !Array.isArray(file.moves) || file.moves.length < 1 ||
        file.moves.length > 5000) invalidReplayFile();

    let exportedDate;
    try {
      exportedDate = new Date(file.exportedAt).toISOString();
    } catch (error) {
      invalidReplayFile();
    }
    if (exportedDate !== file.exportedAt) invalidReplayFile();

    const game = file.game;
    const players = file.players;
    const format = REPLAY_INTERNAL_FORMATS[game.seriesFormat];
    if ((GAME_MODES.indexOf(game.mode) === -1 && game.mode !== "online") || !format ||
        !replayFileText(players.P1, 40) || !replayFileText(players.P2, 40) ||
        !replayFileObject(game.colors) ||
        (game.colors.P1 !== "red" && game.colors.P1 !== "blue") ||
        game.colors.P2 !== (game.colors.P1 === "red" ? "blue" : "red") ||
        (game.view !== "red-bottom" && game.view !== "blue-bottom") ||
        game.startingPlayer !== "red" ||
        !Number.isInteger(game.totalMoves) ||
        game.totalMoves !== file.moves.length ||
        (game.result !== "P1" && game.result !== "P2" && game.result !== "draw") ||
        game.winner !== (game.result === "draw" ? null : players[game.result]) ||
        (game.mode === "vsComputer"
          ? AI_DIFFICULTIES.indexOf(game.aiDifficulty) === -1
          : game.aiDifficulty !== null) ||
        (game.resultDetail !== undefined &&
          (typeof game.resultDetail !== "string" || game.resultDetail.length > 300))) {
      invalidReplayFile();
    }

    const gameNumber = game.gameNumber === undefined ? 1 : game.gameNumber;
    const limit = matchGameLimit(format);
    if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > limit) {
      invalidReplayFile();
    }
    const series = game.seriesScore === undefined
      ? { P1: 0, P2: 0 }
      : game.seriesScore;
    if (!replayFileObject(series) ||
        !Number.isInteger(series.P1) || !Number.isInteger(series.P2) ||
        series.P1 < 0 || series.P2 < 0 ||
        series.P1 + series.P2 > gameNumber) invalidReplayFile();

    const colors = {
      P1: game.colors.P1 === "red" ? "R" : "B",
      P2: game.colors.P2 === "red" ? "R" : "B",
    };
    const names = { [colors.P1]: players.P1, [colors.P2]: players.P2 };
    const initialBoard = createInitialBoard();
    let position = initialBoard.map(function (line) { return line.slice(); });
    const moves = [];
    let turn = "R";

    for (const entry of file.moves) {
      if (!replayFileObject(entry) ||
          (entry.player !== "P1" && entry.player !== "P2") ||
          !isReplayCoordinate(entry.from) || !isReplayCoordinate(entry.to) ||
          !isPlayableSquare(entry.from.row, entry.from.col) ||
          !isPlayableSquare(entry.to.row, entry.to.col) ||
          (entry.piece !== "normal" && entry.piece !== "dama") ||
          !Array.isArray(entry.captures) || entry.captures.length > 12 ||
          !entry.captures.every(isReplayCoordinate) ||
          typeof entry.promoted !== "boolean" ||
          colors[entry.player] !== turn) invalidReplayFile();

      const piece = position[entry.from.row][entry.from.col];
      if (!piece || pieceColor(piece) !== turn ||
          (isDama(piece) ? "dama" : "normal") !== entry.piece) {
        invalidReplayFile();
      }
      const next = position.map(function (line) { return line.slice(); });
      const path = [cloneSquare(entry.from)];
      const capturedSquares = [];
      if (entry.captures.length) {
        const visited = new Set([entry.from.row + "," + entry.from.col]);
        let current = entry.from;
        for (const captured of entry.captures) {
          const hop = getCaptureSteps(next, current.row, current.col).find(
            function (step) {
              return step.captureRow === captured.row &&
                step.captureCol === captured.col;
            }
          );
          if (!hop || visited.has(hop.toRow + "," + hop.toCol)) {
            invalidReplayFile();
          }
          const taken = next[captured.row][captured.col];
          next[current.row][current.col] = null;
          next[captured.row][captured.col] = null;
          next[hop.toRow][hop.toCol] = piece;
          capturedSquares.push({ row: captured.row, col: captured.col, piece: taken });
          current = { row: hop.toRow, col: hop.toCol };
          visited.add(current.row + "," + current.col);
          path.push(current);
        }
        if (current.row !== entry.to.row || current.col !== entry.to.col) {
          invalidReplayFile();
        }
      } else {
        if (!getNormalMovesFrom(next, entry.from.row, entry.from.col).some(
          function (step) {
            return step.row === entry.to.row && step.col === entry.to.col;
          }
        )) invalidReplayFile();
        next[entry.from.row][entry.from.col] = null;
        next[entry.to.row][entry.to.col] = piece;
        path.push(cloneSquare(entry.to));
      }
      if (entry.promoted !== (!isDama(piece) &&
          entry.to.row === promotionRow(turn))) invalidReplayFile();
      if (entry.promoted) next[entry.to.row][entry.to.col] = promotePiece(piece);

      const captured = entry.captures.length > 0;
      moves.push({
        player: turn,
        piece,
        from: cloneSquare(entry.from),
        to: cloneSquare(entry.to),
        path,
        capture: captured,
        capturedSquares,
        promoted: entry.promoted,
        notation: formatMove(path, captured, entry.promoted),
      });
      position = next;
      turn = opposite(turn);
    }

    const winner = game.result === "draw" ? null : colors[game.result];
    const title = winner
      ? players[game.result] + (players[game.result] === "You" ? " win" : " wins") +
        (format === "single" ? "" : " Game " + gameNumber)
      : format === "single" ? "Draw" : "Game " + gameNumber + " drawn";
    const data = {
      version: REPLAY_VERSION,
      createdAt: file.exportedAt,
      mode: game.mode,
      format,
      difficulty: game.aiDifficulty,
      gameNumber,
      startingPlayer: "R",
      colors,
      players: names,
      series: { P1: series.P1, P2: series.P2 },
      initialBoard,
      finalBoard: position,
      moves,
      result: {
        winner,
        title,
        detail: game.resultDetail || "",
      },
    };
    if (!isReplayData(data)) invalidReplayFile();
    return { data, exportedAt: file.exportedAt, view: game.view };
  }

  /* ------------------------------------------------------------------ */
  /* Basic board helpers                                                */
  /* ------------------------------------------------------------------ */

  const insideBoard = (row, col) =>
    row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;

  const pieceColor = (piece) => (piece ? piece[0] : null);

  const isDama = (piece) => piece === "RD" || piece === "BD";

  const opposite = (player) => (player === "R" ? "B" : "R");

  const promotionRow = (color) => PROMOTION_ROW[color];

  const promotePiece = (piece) =>
    piece === "R" ? "RD" : piece === "B" ? "BD" : piece;

  const isPlayableSquare = (row, col) =>
    insideBoard(row, col) && (row + col) % 2 === 1;

  const isOwnPiece = (row, col, player) => {
    if (!insideBoard(row, col)) return false;
    const piece = board[row][col];
    return Boolean(piece) && pieceColor(piece) === player;
  };

  function createInitialBoard() {
    const newBoard = Array.from({ length: BOARD_SIZE }, () =>
      Array(BOARD_SIZE).fill(null)
    );

    // Blue occupies the top three rows, Red the bottom three.
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (isPlayableSquare(row, col)) newBoard[row][col] = "B";
      }
    }

    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (isPlayableSquare(row, col)) newBoard[row][col] = "R";
      }
    }

    return newBoard;
  }

  function countPieces(color) {
    let total = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (pieceColor(board[row][col]) === color) total++;
      }
    }
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Move generation                                                    */
  /* ------------------------------------------------------------------ */

  // Normal moves: one square forward diagonally for a normal piece, any number
  // of empty squares along a diagonal for a Dama.
  function getNormalMovesFrom(source, row, col) {
    const piece = source[row] ? source[row][col] : null;
    if (!piece) return [];
    const color = pieceColor(piece);
    const moves = [];

    if (isDama(piece)) {
      for (const [dr, dc] of DIAGONAL_DIRECTIONS) {
        let r = row + dr;
        let c = col + dc;
        while (insideBoard(r, c) && source[r][c] === null) {
          moves.push({ row: r, col: c });
          r += dr;
          c += dc;
        }
      }
      return moves;
    }

    const forward = color === "R" ? -1 : 1;
    for (const dc of [-1, 1]) {
      const r = row + forward;
      const c = col + dc;
      if (insideBoard(r, c) && source[r][c] === null) {
        moves.push({ row: r, col: c });
      }
    }
    return moves;
  }

  function getNormalMoves(row, col) {
    return getNormalMovesFrom(board, row, col);
  }

  // Single capture jumps from a square. A Dama scans outward until it meets the
  // first piece: an enemy piece with an empty square beyond can be jumped; its
  // own piece blocks that direction entirely.
  function getCaptureSteps(source, row, col) {
    const piece = source[row][col];
    if (!piece) return [];
    const color = pieceColor(piece);
    const steps = [];

    if (isDama(piece)) {
      for (const [dr, dc] of DIAGONAL_DIRECTIONS) {
        let r = row + dr;
        let c = col + dc;
        while (insideBoard(r, c) && source[r][c] === null) {
          r += dr;
          c += dc;
        }
        if (!insideBoard(r, c)) continue;
        if (pieceColor(source[r][c]) === color) continue;
        const landingRow = r + dr;
        const landingCol = c + dc;
        if (insideBoard(landingRow, landingCol) && source[landingRow][landingCol] === null) {
          steps.push({
            toRow: landingRow,
            toCol: landingCol,
            captureRow: r,
            captureCol: c,
            captured: source[r][c],
          });
        }
      }
      return steps;
    }

    for (const [dr, dc] of DIAGONAL_DIRECTIONS) {
      const midRow = row + dr;
      const midCol = col + dc;
      const landingRow = row + dr * 2;
      const landingCol = col + dc * 2;
      if (!insideBoard(landingRow, landingCol)) continue;
      const middle = source[midRow][midCol];
      if (
        middle &&
        pieceColor(middle) !== color &&
        source[landingRow][landingCol] === null
      ) {
        steps.push({
          toRow: landingRow,
          toCol: landingCol,
          captureRow: midRow,
          captureCol: midCol,
          captured: middle,
        });
      }
    }
    return steps;
  }

  function getCaptureMoves(row, col) {
    return getCaptureSteps(board, row, col);
  }

  // Recursively enumerate every capture chain from a square. Captured pieces are
  // removed while exploring, and visited landing squares are tracked so a chain
  // cannot loop forever. An ordinary piece that reaches the promotion row keeps
  // jumping as an ordinary piece; it promotes only if the turn ends there.
  function getAllCaptureChains(row, col, source = board) {
    const startPiece = source[row] ? source[row][col] : null;
    if (!startPiece) return [];
    const color = pieceColor(startPiece);
    const results = [];

    const search = (currentBoard, fromRow, fromCol, piece, path, captures, visited) => {
      const steps = getCaptureSteps(currentBoard, fromRow, fromCol);
      let tookStep = false;

      for (const step of steps) {
        const key = step.toRow + "," + step.toCol;
        if (visited.has(key)) continue;
        tookStep = true;

        const nextBoard = currentBoard.map((line) => line.slice());
        nextBoard[fromRow][fromCol] = null;
        nextBoard[step.toRow][step.toCol] = piece;
        nextBoard[step.captureRow][step.captureCol] = null;

        const nextCaptures = captures.concat([
          { row: step.captureRow, col: step.captureCol },
        ]);
        const nextPath = path.concat([{ row: step.toRow, col: step.toCol }]);
        const nextVisited = new Set(visited);
        nextVisited.add(key);

        search(nextBoard, step.toRow, step.toCol, piece, nextPath, nextCaptures, nextVisited);
      }

      if (!tookStep && captures.length > 0) {
        const destination = path[path.length - 1];
        results.push({
          path,
          captures,
          promoted:
            !isDama(startPiece) &&
            destination.row === promotionRow(color),
        });
      }
    };

    search(source, row, col, startPiece, [], [], new Set([row + "," + col]));
    return results;
  }

  // Every piece that has at least one capture available.
  function getMandatoryCapturePieces(player) {
    const pieces = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!isOwnPiece(row, col, player)) continue;
        if (getAllCaptureChains(row, col).length > 0) {
          pieces.push({ row, col });
        }
      }
    }
    return pieces;
  }

  // Only chains that remove the maximum possible number of enemy pieces.
  function getBestCaptureChains(player) {
    let best = [];
    let bestCount = 0;

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!isOwnPiece(row, col, player)) continue;
        const chains = getAllCaptureChains(row, col);
        for (const chain of chains) {
          const count = chain.captures.length;
          if (count === 0) continue;
          if (count > bestCount) {
            bestCount = count;
            best = [{ row, col, chain }];
          } else if (count === bestCount) {
            best.push({ row, col, chain });
          }
        }
      }
    }
    return best;
  }

  function hasAnyLegalMove(player) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (!isOwnPiece(row, col, player)) continue;
        if (getNormalMoves(row, col).length > 0) return true;
        if (getCaptureSteps(board, row, col).length > 0) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* AI move generation and search                                      */
  /* ------------------------------------------------------------------ */

  function normalizeChainMove(row, col, chain) {
    const path = clonePath(chain.path);
    return {
      from: { row, col },
      path,
      captures: chain.captures.map(function (piece) {
        return { row: piece.row, col: piece.col };
      }),
      promoted: chain.promoted,
      capture: true,
      chain: {
        path: clonePath(chain.path),
        captures: chain.captures.map(function (piece) {
          return { row: piece.row, col: piece.col };
        }),
        promoted: chain.promoted,
      },
    };
  }

  // Every legal move, restricted to maximum-length captures when any capture
  // exists. This is the single source of truth for both AI difficulties and
  // tests, so strategy can never override the Filipino Dama rules.
  function getLegalMovesFor(source, player) {
    let bestChains = [];
    let bestCount = 0;

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece || pieceColor(piece) !== player) continue;
        const chains = getAllCaptureChains(row, col, source);
        for (const chain of chains) {
          if (chain.captures.length > bestCount) {
            bestCount = chain.captures.length;
            bestChains = [{ row, col, chain }];
          } else if (chain.captures.length === bestCount) {
            bestChains.push({ row, col, chain });
          }
        }
      }
    }

    if (bestCount > 0) {
      return bestChains.map(function (entry) {
        return normalizeChainMove(entry.row, entry.col, entry.chain);
      });
    }

    const moves = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece || pieceColor(piece) !== player) continue;
        const destinations = getNormalMovesFrom(source, row, col);
        for (const destination of destinations) {
          moves.push({
            from: { row, col },
            path: [{ row: destination.row, col: destination.col }],
            captures: [],
            promoted:
              !isDama(piece) &&
              destination.row === promotionRow(pieceColor(piece)),
            capture: false,
            chain: null,
          });
        }
      }
    }
    return moves;
  }

  function applyMoveToBoard(source, move) {
    const next = source.map(function (line) {
      return line.slice();
    });
    const piece = next[move.from.row] ? next[move.from.row][move.from.col] : null;
    if (!piece) return next;

    next[move.from.row][move.from.col] = null;
    for (const captured of move.captures) {
      next[captured.row][captured.col] = null;
    }
    const destination = move.path[move.path.length - 1];
    if (destination) {
      next[destination.row][destination.col] = move.promoted
        ? promotePiece(piece)
        : piece;
    }
    return next;
  }

  const AI_PIECE_VALUE = 100;
  const AI_DAMA_VALUE = 280;
  const AI_MATE_SCORE = 1000000;
  const SEARCH_ABORTED = { aborted: true };

  function searchNow() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function countMobilityFor(source, player) {
    let total = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece || pieceColor(piece) !== player) continue;
        const captures = getCaptureSteps(source, row, col);
        total += captures.length > 0
          ? captures.length
          : getNormalMovesFrom(source, row, col).length;
      }
    }
    return total;
  }

  function countThreatenedFor(source, side) {
    const targets = new Set();
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece || pieceColor(piece) === side) continue;
        for (const step of getCaptureSteps(source, row, col)) {
          const target = source[step.captureRow][step.captureCol];
          if (target && pieceColor(target) === side) {
            targets.add(step.captureRow + "," + step.captureCol);
          }
        }
      }
    }
    return targets.size;
  }

  function maxCaptureCountFor(source, player) {
    let best = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece || pieceColor(piece) !== player) continue;
        const chains = getAllCaptureChains(row, col, source);
        for (const chain of chains) {
          best = Math.max(best, chain.captures.length);
        }
      }
    }
    return best;
  }

  function evaluateBoard(source, perspective, deep) {
    let score = 0;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const piece = source[row] ? source[row][col] : null;
        if (!piece) continue;
        const color = pieceColor(piece);
        const sign = color === perspective ? 1 : -1;
        let value = isDama(piece) ? AI_DAMA_VALUE : AI_PIECE_VALUE;

        if (!isDama(piece)) {
          const distance = color === "R" ? row : BOARD_SIZE - 1 - row;
          value += (6 - distance) * 4;
        }

        const centerDistance = Math.abs(row - 3.5) + Math.abs(col - 3.5);
        value += Math.max(0, Math.round((7 - centerDistance) * 2));
        score += sign * value;
      }
    }

    const rival = opposite(perspective);
    const mobility =
      countMobilityFor(source, perspective) - countMobilityFor(source, rival);
    score += mobility * (deep ? 3 : 2);

    if (deep) {
      const safety =
        countThreatenedFor(source, rival) - countThreatenedFor(source, perspective);
      score += safety * 14;
      const potential =
        maxCaptureCountFor(source, perspective) - maxCaptureCountFor(source, rival);
      score += potential * 18;
    }

    return score;
  }

  function orderSearchMoves(moves) {
    return moves.slice().sort(function (a, b) {
      return (
        b.captures.length - a.captures.length ||
        (b.promoted ? 1 : 0) - (a.promoted ? 1 : 0) ||
        (a.capture ? 0 : 1) - (b.capture ? 0 : 1)
      );
    });
  }

  async function enterSearchNode(context) {
    context.nodes += 1;
    if (context.token !== aiToken) throw SEARCH_ABORTED;
    if (context.nodes % AI_YIELD_INTERVAL === 0) {
      await new Promise(function (resolve) {
        window.setTimeout(resolve, 0);
      });
      if (context.token !== aiToken) throw SEARCH_ABORTED;
    }
    if (searchNow() >= context.deadline) throw SEARCH_ABORTED;
  }

  async function minimax(source, depth, alpha, beta, side, context) {
    await enterSearchNode(context);
    if (depth <= 0) {
      return evaluateBoard(source, aiSide(), context.deep);
    }

    const moves = getLegalMovesFor(source, side);
    if (moves.length === 0) {
      return side === aiSide() ? -AI_MATE_SCORE : AI_MATE_SCORE;
    }

    const ordered = orderSearchMoves(moves);
    if (side === aiSide()) {
      let value = -AI_MATE_SCORE;
      for (const move of ordered) {
        const next = applyMoveToBoard(source, move);
        value = Math.max(
          value,
          await minimax(next, depth - 1, alpha, beta, humanSide(), context)
        );
        alpha = Math.max(alpha, value);
        if (alpha >= beta) break;
      }
      return value;
    }

    let value = AI_MATE_SCORE;
    for (const move of ordered) {
      const next = applyMoveToBoard(source, move);
      value = Math.min(
        value,
        await minimax(next, depth - 1, alpha, beta, aiSide(), context)
      );
      beta = Math.min(beta, value);
      if (alpha >= beta) break;
    }
    return value;
  }

  async function searchRoot(source, depth, deadline, token, deep) {
    const moves = orderSearchMoves(getLegalMovesFor(source, aiSide()));
    if (moves.length === 0) return null;

    const context = { deadline, token, nodes: 0, deep };
    let bestScore = -AI_MATE_SCORE;
    let bestMoves = [];
    let alpha = -AI_MATE_SCORE;

    for (const move of moves) {
      const next = applyMoveToBoard(source, move);
      const score = await minimax(
        next,
        depth - 1,
        alpha,
        AI_MATE_SCORE,
        humanSide(),
        context
      );
      if (score > bestScore) {
        bestScore = score;
        bestMoves = [move];
      } else if (score === bestScore) {
        bestMoves.push(move);
      }
      alpha = Math.max(alpha, score);
    }

    return bestMoves.length
      ? { move: bestMoves[Math.floor(Math.random() * bestMoves.length)], score: bestScore }
      : null;
  }

  async function chooseAiMove(source, difficulty, token) {
    const searchToken = token === undefined ? aiToken : token;
    const moves = getLegalMovesFor(source, aiSide());
    if (moves.length === 0) return null;
    if (difficulty === "easy") {
      return moves[Math.floor(Math.random() * moves.length)];
    }

    if (difficulty === "medium") {
      try {
        const result = await searchRoot(
          source,
          2,
          searchNow() + 700,
          searchToken,
          false
        );
        return result ? result.move : moves[0];
      } catch (error) {
        if (error !== SEARCH_ABORTED) throw error;
        return searchToken === aiToken ? moves[0] : null;
      }
    }

    let best = moves[0];
    const deadline = searchNow() + AI_HARD_TIME_MS;
    for (let depth = 1; depth <= AI_HARD_MAX_DEPTH; depth += 1) {
      try {
        const result = await searchRoot(
          source,
          depth,
          deadline,
          searchToken,
          true
        );
        if (result) best = result.move;
      } catch (error) {
        if (error !== SEARCH_ABORTED) throw error;
        break;
      }
      if (searchNow() >= deadline) break;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Names, scores, sound, theme                                        */
  /* ------------------------------------------------------------------ */

  function displayName(player) {
    const id = playerForColor(player);
    const value = (names[id] || "").trim();
    if (gameMode === "vsComputer") {
      if (id === "P2") return AI_NAME;
      if (!value || value === DEFAULT_NAMES.P1 || value === HUMAN_DEFAULT_LABEL) {
        return HUMAN_DEFAULT_LABEL;
      }
      return value;
    }
    return value || DEFAULT_NAMES[id];
  }

  function winMessage(winner) {
    const label = displayName(winner);
    if (isVsComputer()) {
      return label === HUMAN_DEFAULT_LABEL ? "You win!" : label + " wins!";
    }
    return label + " Wins!";
  }

  function winSentence(winner) {
    const label = displayName(winner);
    return label === HUMAN_DEFAULT_LABEL ? "You win." : label + " wins.";
  }

  function isVsComputer() {
    return gameMode === "vsComputer";
  }

  function colorForPlayer(id) {
    return playerColors[id];
  }

  function playerForColor(color) {
    return playerColors.P1 === color ? "P1" : "P2";
  }

  function humanSide() {
    return colorForPlayer("P1");
  }

  function aiSide() {
    return colorForPlayer("P2");
  }

  function setGameColors() {
    const firstColor = currentGameNumber % 2 === 1 || !isSeriesMatch()
      ? gameOneColor
      : opposite(gameOneColor);
    playerColors = { P1: firstColor, P2: opposite(firstColor) };
  }

  function setBoardOrientation(boardElement, squares, files, ranks, flipped, replay) {
    boardElement.setAttribute("data-orientation", flipped ? "blue" : "red");
    boardElement.setAttribute(
      "aria-label",
      (replay ? "Read-only replay board" : "Dama board") +
        (flipped
          ? ". Blue pieces at the bottom, Red pieces at the top."
          : ". Red pieces at the bottom, Blue pieces at the top.")
    );

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const index = row * BOARD_SIZE + col;
        squares[row][col].style.order = flipped
          ? String(BOARD_SIZE * BOARD_SIZE - 1 - index)
          : "";
      }
    }

    for (let index = 0; index < BOARD_SIZE; index++) {
      if (files.children[index]) {
        files.children[index].textContent = String.fromCharCode(
          65 + (flipped ? BOARD_SIZE - 1 - index : index)
        );
      }
      if (ranks.children[index]) {
        ranks.children[index].textContent = String(
          flipped ? index + 1 : BOARD_SIZE - index
        );
      }
    }
  }

  function matchGameLimit(format = matchFormat) {
    return MATCH_GAME_LIMITS[format] || 1;
  }

  function isSeriesMatch() {
    return matchGameLimit() > 1;
  }

  function matchFormatLabel(format) {
    return format === "single" ? "Single game" : "Best of " + matchGameLimit(format);
  }

  function startLabel(player) {
    const label = displayName(player);
    return label === HUMAN_DEFAULT_LABEL ? "You start" : label + " starts";
  }

  function gameSeriesMessage(winner) {
    const label = displayName(winner);
    if (label === HUMAN_DEFAULT_LABEL) return "You win Game " + currentGameNumber + "!";
    return label + " wins Game " + currentGameNumber + "!";
  }

  function matchWinMessage(winner) {
    const label = displayName(winner);
    if (label === HUMAN_DEFAULT_LABEL) return "You win the match!";
    return label + " wins the match!";
  }

  function seriesLabel() {
    return (
      displayName(colorForPlayer("P1")) +
      " " +
      seriesScores.P1 +
      " – " +
      seriesScores.P2 +
      " " +
      displayName(colorForPlayer("P2"))
    );
  }

  function isAiTurn() {
    return isVsComputer() && currentPlayer === aiSide() && !gameOver;
  }

  function humanInputBlocked() {
    return gameOver || isAnimating || aiThinking || aiApplying || isAiTurn();
  }

  function applyModeLabels() {
    if (!dom.nameRed || !dom.nameBlue) return;
    const vsComputer = isVsComputer();
    for (const color of ["R", "B"]) {
      const id = playerForColor(color);
      const computer = vsComputer && id === "P2";
      const input = color === "R" ? dom.nameRed : dom.nameBlue;
      const role = color === "R" ? dom.redRole : dom.blueRole;
      role.textContent = vsComputer
        ? computer ? AI_NAME : HUMAN_DEFAULT_LABEL
        : id === "P1" ? "Player 1 · " + COLOR_NAMES[color] : "Player 2 · " + COLOR_NAMES[color];
      input.value = computer ? AI_NAME : displayName(color);
      input.placeholder = vsComputer && !computer ? HUMAN_DEFAULT_LABEL : DEFAULT_NAMES[id];
      input.readOnly = computer;
      input.setAttribute("aria-label", computer ? "Computer player" : COLOR_NAMES[color] + " player name");
    }
  }

  function syncColorUI() {
    if (!dom.colorRadios) return;
    dom.colorRadios.forEach(function (radio) {
      radio.checked = radio.value === gameOneColor;
    });
    dom.colorLegend.textContent = isVsComputer()
      ? "Your color in Game 1"
      : "Player 1 color in Game 1";
  }

  function setStartColor(color) {
    if (color !== "R" && color !== "B") return;
    gameOneColor = color;
    saveGameSettings();
    syncColorUI();
  }

  function syncFormatUI() {
    if (dom.formatRadios) {
      dom.formatRadios.forEach(function (radio) {
        radio.checked = radio.value === matchFormat;
      });
    }
    if (dom.btnStart) {
      dom.btnStart.textContent = isSeriesMatch() ? "Start Match" : "Start Game";
    }
    if (dom.btnRestart) {
      dom.btnRestart.textContent = isSeriesMatch() ? "Restart Match" : "New Game";
    }
    renderMatchStrip();
  }

  function setMatchFormat(nextFormat) {
    if (MATCH_FORMATS.indexOf(nextFormat) === -1) return;
    matchFormat = nextFormat;
    saveGameSettings();
    syncFormatUI();
  }

  function syncModeUI() {
    if (dom.modeRadios) {
      dom.modeRadios.forEach(function (radio) {
        radio.checked = radio.value === gameMode;
      });
    }
    if (dom.difficultyField) {
      dom.difficultyField.hidden = !isVsComputer();
    }
    if (dom.aiDifficulty) dom.aiDifficulty.value = aiDifficulty;
    syncColorUI();
    syncFormatUI();
    applyModeLabels();
  }

  function updateSoundUI() {
    if (!dom.btnSound) return;
    dom.btnSound.setAttribute("aria-pressed", soundEnabled ? "true" : "false");
    dom.btnSound.setAttribute(
      "aria-label",
      soundEnabled ? "Mute sound effects" : "Enable sound effects"
    );
    dom.soundLabel.textContent = soundEnabled ? "Sound on" : "Sound off";
  }

  function updateThemeMeta() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[currentTheme] || THEME_COLORS.wood);
  }

  function setTheme(theme) {
    if (THEMES.indexOf(theme) === -1) return;
    currentTheme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    storageSet(STORAGE_KEYS.theme, theme);
    updateThemeMeta();
    if (dom.themeSelect) dom.themeSelect.value = theme;
  }

  function getAudioContext() {
    if (!soundEnabled) return null;
    if (!audioContext) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        audioContext = new Ctor();
      } catch (error) {
        return null;
      }
    }
    return audioContext;
  }

  function getSfxBus(context) {
    if (!context) return null;
    if (sfxBus && sfxBusContext === context) return sfxBus;

    const master = context.createGain();
    master.gain.setValueAtTime(1.2, context.currentTime);

    let output = master;
    if (typeof context.createDynamicsCompressor === "function") {
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-2, context.currentTime);
      limiter.knee.setValueAtTime(0, context.currentTime);
      limiter.ratio.setValueAtTime(20, context.currentTime);
      limiter.attack.setValueAtTime(0.001, context.currentTime);
      limiter.release.setValueAtTime(0.12, context.currentTime);
      master.connect(limiter);
      output = limiter;
    }

    output.connect(context.destination);
    sfxBus = master;
    sfxBusContext = context;
    return sfxBus;
  }

  function resumeAudioContext(context) {
    if (!context || context.state !== "suspended") return null;
    try {
      return context.resume();
    } catch (error) {
      return null;
    }
  }

  function unlockAudio() {
    if (!soundEnabled) return;
    const context = getAudioContext();
    const resumed = resumeAudioContext(context);
    if (resumed && typeof resumed.catch === "function") resumed.catch(function () {});
  }

  function playTone(frequency, delay, duration, type, peak) {
    const context = getAudioContext();
    if (!context) return;
    const offset = delay || 0;

    function schedule(baseTime) {
      try {
        const start = baseTime + offset;
        const level = peak || 0.34;
        const attack = Math.min(0.008, duration * 0.2);
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type || "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(level, start + attack);
        gain.gain.exponentialRampToValueAtTime(level * 0.35, start + duration * 0.6);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.02);
        const bus = getSfxBus(context);
        if (!bus) return;
        oscillator.connect(gain);
        gain.connect(bus);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.03);
      } catch (error) {
        /* Audio is optional; never let it break the game. */
      }
    }

    if (context.state === "suspended") {
      const resumed = resumeAudioContext(context);
      if (resumed && typeof resumed.then === "function") {
        resumed
          .then(function () {
            schedule(context.currentTime);
          })
          .catch(function () {});
        return;
      }
      schedule(context.currentTime);
      return;
    }

    schedule(context.currentTime);
  }

  function playSound(name, delay) {
    if (!soundEnabled) return;
    const offset = delay || 0;
    if (name === "move") {
      playTone(340, offset, 0.12, "triangle", 0.34);
      playTone(1200, offset, 0.05, "triangle", 0.13);
    } else if (name === "capture") {
      playTone(220, offset, 0.12, "triangle", 0.36);
      playTone(150, offset + 0.06, 0.12, "sine", 0.26);
      playTone(1300, offset, 0.05, "triangle", 0.13);
    } else if (name === "promotion") {
      playTone(523.25, offset, 0.18, "sine", 0.26);
      playTone(659.25, offset + 0.1, 0.18, "sine", 0.26);
      playTone(783.99, offset + 0.2, 0.24, "sine", 0.26);
    } else if (name === "win") {
      playTone(523.25, offset, 0.2, "triangle", 0.26);
      playTone(659.25, offset + 0.14, 0.2, "triangle", 0.26);
      playTone(783.99, offset + 0.28, 0.22, "triangle", 0.26);
      playTone(1046.5, offset + 0.46, 0.38, "triangle", 0.3);
    } else if (name === "invalid") {
      playTone(140, offset, 0.14, "square", 0.14);
    }
  }

  function setSoundEnabled(next) {
    soundEnabled = Boolean(next);
    storageSet(STORAGE_KEYS.sound, soundEnabled ? "on" : "off");
    updateSoundUI();
    if (soundEnabled) {
      getAudioContext();
      playSound("move");
    }
  }

  function announce(text) {
    if (!dom.announcer) return;
    dom.announcer.textContent = "";
    window.setTimeout(function () {
      if (dom.announcer) dom.announcer.textContent = text;
    }, 20);
  }

  /* ------------------------------------------------------------------ */
  /* Turn state and snapshots                                           */
  /* ------------------------------------------------------------------ */

  function activePieceSquare() {
    return chainPath.length > 0 ? chainPath[chainPath.length - 1] : selectedPiece;
  }

  function hopsAt(chains, index) {
    const hops = [];
    const seen = new Set();
    for (const entry of chains) {
      const step = entry.chain.path[index];
      if (!step) continue;
      const key = step.row + "," + step.col;
      if (seen.has(key)) continue;
      seen.add(key);
      hops.push({ row: step.row, col: step.col, capture: true });
    }
    return hops;
  }

  function clonePath(path) {
    return path.map(function (step) {
      return { row: step.row, col: step.col };
    });
  }

  function cloneSquare(position) {
    return position ? { row: position.row, col: position.col } : null;
  }

  function cloneCapturedSquares(squares) {
    return (squares || []).map(function (square) {
      return { row: square.row, col: square.col, piece: square.piece || null };
    });
  }

  function cloneMoveRecord(record) {
    return {
      player: record.player,
      piece: record.piece || null,
      from: cloneSquare(record.from || (record.path && record.path[0])),
      to: cloneSquare(
        record.to ||
          (record.path && record.path.length
            ? record.path[record.path.length - 1]
            : null)
      ),
      path: clonePath(record.path || []),
      capture: Boolean(record.capture),
      capturedSquares: cloneCapturedSquares(record.capturedSquares),
      promoted: Boolean(record.promoted),
      notation: record.notation || "",
    };
  }

  function snapshotState() {
    return {
      board: board.map(function (line) {
        return line.slice();
      }),
      currentPlayer,
      movesWithoutCaptureOrPromotion,
      lastMove: lastMove
        ? { path: clonePath(lastMove.path), capture: lastMove.capture }
        : null,
      moveHistory: moveHistory.map(cloneMoveRecord),
    };
  }

  function startTurn() {
    turnCapturedSquares = [];
    turnBestChains = getBestCaptureChains(currentPlayer);
    mandatoryCapturePieces = [];
    const seen = new Set();
    for (const entry of turnBestChains) {
      const key = entry.row + "," + entry.col;
      if (seen.has(key)) continue;
      seen.add(key);
      mandatoryCapturePieces.push({ row: entry.row, col: entry.col });
    }
    turnStartState = snapshotState();
  }

  function selectPiece(row, col) {
    if (humanInputBlocked() || !isPlayableSquare(row, col)) return false;
    const piece = board[row][col];
    if (!piece || pieceColor(piece) !== currentPlayer) return false;

    if (turnBestChains.length > 0) {
      // Captures are mandatory: only pieces with a maximum-length chain count.
      const chains = turnBestChains.filter(
        (entry) => entry.row === row && entry.col === col
      );
      if (chains.length === 0) return false;
      selectedPiece = { row, col };
      activeChainSet = chains;
      chainPath = [];
      legalMoves = hopsAt(chains, 0);
      return true;
    }

    selectedPiece = { row, col };
    activeChainSet = [];
    chainPath = [];
    legalMoves = getNormalMoves(row, col).map((move) => ({
      row: move.row,
      col: move.col,
      capture: false,
    }));
    return true;
  }

  function clearSelection() {
    selectedPiece = null;
    legalMoves = [];
    activeChainSet = [];
    chainPath = [];
  }

  /* ------------------------------------------------------------------ */
  /* Move execution                                                     */
  /* ------------------------------------------------------------------ */

  function squareLabel(row, col) {
    return String.fromCharCode(97 + col) + (BOARD_SIZE - row);
  }

  function formatMove(path, capture, promoted) {
    const separator = capture ? "x" : "-";
    let text = path
      .map(function (step) {
        return squareLabel(step.row, step.col);
      })
      .join(separator);
    if (promoted) text += "=D";
    return text;
  }

  function executeMove(fromRow, fromCol, toRow, toCol) {
    if (isAnimating || gameOver) return;
    const piece = board[fromRow][fromCol];
    if (!piece) return;
    const allowed = getNormalMoves(fromRow, fromCol).some(
      (move) => move.row === toRow && move.col === toCol
    );
    if (!allowed) return;

    board[fromRow][fromCol] = null;
    board[toRow][toCol] = piece;
    const path = [
      { row: fromRow, col: fromCol },
      { row: toRow, col: toCol },
    ];
    lastMove = {
      path: clonePath(path),
      capture: false,
    };

    const promoted = promoteIfNeeded(toRow, toCol);
    finishTurn({
      captured: false,
      promoted,
      path,
      piece,
      animation: {
        from: { row: fromRow, col: fromCol },
        to: { row: toRow, col: toCol },
        captured: null,
        promoted,
      },
    });
  }

  function promoteIfNeeded(row, col) {
    const piece = board[row][col];
    if (piece === "R" && row === PROMOTION_ROW.R) {
      board[row][col] = "RD";
      return true;
    }
    if (piece === "B" && row === PROMOTION_ROW.B) {
      board[row][col] = "BD";
      return true;
    }
    return false;
  }

  // Applies one jump of the current capture chain and either asks for the next
  // jump (if the maximum chain continues) or ends the turn.
  function applyCaptureHop(toRow, toCol) {
    if (isAnimating || gameOver) return;
    const origin = activePieceSquare();
    if (!origin) return;
    const step = getCaptureSteps(board, origin.row, origin.col).find(
      (candidate) => candidate.toRow === toRow && candidate.toCol === toCol
    );
    if (!step) return;

    const piece = board[origin.row][origin.col];
    turnCapturedSquares.push({
      row: step.captureRow,
      col: step.captureCol,
      piece: step.captured,
    });
    board[origin.row][origin.col] = null;
    board[step.captureRow][step.captureCol] = null;
    board[toRow][toCol] = piece;
    chainPath.push({ row: toRow, col: toCol });
    lastMove = {
      path: [
        { row: selectedPiece.row, col: selectedPiece.col },
        ...chainPath.map((position) => ({ row: position.row, col: position.col })),
      ],
      capture: true,
    };

    activeChainSet = activeChainSet.filter((entry) => {
      const expected = entry.chain.path[chainPath.length - 1];
      return Boolean(expected) && expected.row === toRow && expected.col === toCol;
    });

    const animation = {
      from: { row: origin.row, col: origin.col },
      to: { row: toRow, col: toCol },
      captured: {
        row: step.captureRow,
        col: step.captureCol,
        piece: step.captured,
      },
      promoted: false,
    };
    const turnPath = [
      { row: selectedPiece.row, col: selectedPiece.col },
      ...chainPath.map((position) => ({ row: position.row, col: position.col })),
    ];

    const canContinue = activeChainSet.some(
      (entry) => entry.chain.path.length > chainPath.length
    );
    if (canContinue) {
      legalMoves = hopsAt(activeChainSet, chainPath.length);
      refreshUI();
      playSound("capture");
      runAnimation(animation);
      return;
    }

    const promoted =
      !isDama(piece) && toRow === promotionRow(pieceColor(piece));
    if (promoted) {
      board[toRow][toCol] = promotePiece(piece);
      animation.promoted = true;
    }

    finishTurn({
      captured: true,
      promoted,
      path: turnPath,
      piece,
      animation,
    });
  }

  function finishTurn(options) {
    const captured = Boolean(options.captured);
    const promoted = Boolean(options.promoted);
    const path = options.path;
    const animation = options.animation || null;
    const mover = currentPlayer;

    clearSelection();
    if (captured || promoted) {
      movesWithoutCaptureOrPromotion = 0;
    } else {
      movesWithoutCaptureOrPromotion += 1;
    }

    const record = {
      player: mover,
      piece: options.piece || null,
      from: path.length ? { row: path[0].row, col: path[0].col } : null,
      to: path.length
        ? { row: path[path.length - 1].row, col: path[path.length - 1].col }
        : null,
      path: clonePath(path),
      capture: captured,
      capturedSquares: cloneCapturedSquares(turnCapturedSquares),
      promoted,
      notation: formatMove(path, captured, promoted),
    };
    turnCapturedSquares = [];
    moveHistory.push(record);

    if (turnStartState) {
      gameHistory.push(turnStartState);
      turnStartState = null;
    }

    switchTurn();

    const result = evaluateGameState(currentPlayer);
    if (result) {
      applyEndState(result);
    } else {
      startTurn();
    }

    refreshUI();
    announceMove(record, result);

    if (captured) playSound("capture");
    else playSound("move");
    if (promoted) playSound("promotion", captured ? 0.08 : 0.1);

    const duration = runAnimation(animation);

    if (result) {
      scheduleReveal(duration);
    } else {
      scheduleAiTurn(duration);
    }
  }

  function cancelAiTurn() {
    aiToken += 1;
    if (aiTimer) {
      window.clearTimeout(aiTimer);
      aiTimer = 0;
    }
    aiThinking = false;
    aiApplying = false;
  }

  function waitForAnimation(token) {
    return new Promise(function (resolve) {
      let attempts = 0;
      const poll = function () {
        if (!isAnimating || token !== aiToken || attempts >= 60) {
          resolve();
          return;
        }
        attempts += 1;
        window.setTimeout(poll, 30);
      };
      poll();
    });
  }

  async function performAiMove(move, token) {
    if (!move || token !== aiToken || !isAiTurn()) return;

    aiThinking = false;
    aiApplying = true;
    updateStatus();
    updateControls();

    if (!move.capture) {
      const destination = move.path[move.path.length - 1];
      if (!destination) return;
      executeMove(move.from.row, move.from.col, destination.row, destination.col);
      if (token === aiToken) {
        aiApplying = false;
        updateStatus();
        updateControls();
      }
      return;
    }

    selectedPiece = { row: move.from.row, col: move.from.col };
    activeChainSet = [
      {
        row: move.from.row,
        col: move.from.col,
        chain: {
          path: clonePath(move.chain.path),
          captures: move.chain.captures.map(function (piece) {
            return { row: piece.row, col: piece.col };
          }),
          promoted: move.chain.promoted,
        },
      },
    ];
    chainPath = [];
    legalMoves = [];

    for (const step of move.chain.path) {
      if (token !== aiToken || !isAiTurn()) return;
      applyCaptureHop(step.row, step.col);
      await waitForAnimation(token);
      if (token !== aiToken || gameOver || currentPlayer !== aiSide()) break;
    }

    if (token === aiToken) {
      aiApplying = false;
      updateStatus();
      updateControls();
    }
  }

  async function runAiTurn(token) {
    try {
      const move = await chooseAiMove(
        board.map(function (line) {
          return line.slice();
        }),
        matchDifficulty,
        token
      );
      if (!move || token !== aiToken || !isAiTurn()) {
        if (token === aiToken) {
          aiThinking = false;
          updateStatus();
          updateControls();
        }
        return;
      }
      await performAiMove(move, token);
    } catch (error) {
      if (error !== SEARCH_ABORTED && token === aiToken) {
        aiThinking = false;
        aiApplying = false;
        updateStatus();
        updateControls();
      }
    }
  }

  function scheduleAiTurn(animationDuration) {
    if (!isAiTurn() || aiThinking || aiApplying) return;
    aiToken += 1;
    const token = aiToken;
    aiThinking = true;
    updateStatus();
    updateControls();

    const delay = Math.max(
      AI_MIN_THINK_MS,
      Math.round(animationDuration || 0) + 100
    );
    aiTimer = window.setTimeout(function () {
      aiTimer = 0;
      if (token !== aiToken) return;
      if (!isAiTurn()) {
        aiThinking = false;
        updateStatus();
        updateControls();
        return;
      }
      runAiTurn(token);
    }, delay);
  }

  function switchTurn() {
    currentPlayer = opposite(currentPlayer);
  }

  // Pure end-state evaluation so the win/draw rules can be reasoned about and
  // tested without touching the DOM. Returns null while the game continues.
  function evaluateGameState(player) {
    const rival = opposite(player);
    if (countPieces(player) === 0) {
      return {
        winner: rival,
        title: COLOR_NAMES[rival] + " Wins!",
        detail: COLOR_NAMES[player] + " has no pieces left on the board.",
      };
    }
    if (!hasAnyLegalMove(player)) {
      return {
        winner: rival,
        title: COLOR_NAMES[rival] + " Wins!",
        detail: COLOR_NAMES[player] + " has pieces but no legal move.",
      };
    }
    if (movesWithoutCaptureOrPromotion >= DRAW_PLY_LIMIT) {
      return {
        winner: null,
        title: "Draw",
        detail: "100 moves each without a capture or a promotion.",
      };
    }
    return null;
  }

  function applyEndState(result) {
    gameOver = true;
    gameResult = result;
    if (result.winner) {
      const winnerId = playerForColor(result.winner);
      scores[winnerId] += 1;
      saveScores();
    }
    if (isSeriesMatch() && result.winner) {
      seriesScores[playerForColor(result.winner)] += 1;
    }
    if (isSeriesMatch()) {
      const seriesFinished =
        seriesScores.P1 > matchGameLimit() / 2 ||
        seriesScores.P2 > matchGameLimit() / 2 ||
        currentGameNumber >= matchGameLimit();
      if (seriesFinished) {
        if (seriesScores.P1 === seriesScores.P2) matchWinner = "draw";
        else matchWinner = seriesScores.P1 > seriesScores.P2 ? "P1" : "P2";
      }
    }
    recordGameResult(result);
    if (isSeriesMatch() && matchWinner) recordSeriesResult();
    saveLastReplay(buildReplayData(result));
    renderScores();
    renderMatchStrip();
    updateEndStateText();
  }

  function updateEndStateText() {
    if (!gameResult) return;
    const winner = gameResult.winner;
    const seriesMatch = isSeriesMatch();
    const finalResult = seriesMatch ? Boolean(matchWinner) : false;

    dom.endCard.classList.remove("winner-red", "winner-blue", "winner-draw");
    if (seriesMatch && finalResult) {
      if (matchWinner === "draw") {
        dom.endTitle.textContent = "Match Drawn";
        dom.endCard.classList.add("winner-draw");
      } else {
        const winnerColor = colorForPlayer(matchWinner);
        dom.endTitle.textContent = matchWinMessage(winnerColor);
        dom.endCard.classList.add(winnerColor === "R" ? "winner-red" : "winner-blue");
      }
      dom.endEyebrow.textContent = "Match complete";
    } else if (seriesMatch) {
      dom.endEyebrow.textContent =
        "Game " + currentGameNumber + " of " + matchGameLimit() + " complete";
      if (winner === "R" || winner === "B") {
        dom.endTitle.textContent = gameSeriesMessage(winner);
        dom.endCard.classList.add(winner === "R" ? "winner-red" : "winner-blue");
      } else {
        dom.endTitle.textContent = "Game " + currentGameNumber + " drawn";
        dom.endCard.classList.add("winner-draw");
      }
    } else {
      dom.endEyebrow.textContent = "Game over";
      if (winner === "R" || winner === "B") {
        dom.endTitle.textContent = winMessage(winner);
        dom.endCard.classList.add(winner === "R" ? "winner-red" : "winner-blue");
      } else {
        dom.endTitle.textContent = "Draw";
        dom.endCard.classList.add("winner-draw");
      }
    }

    dom.endMeta.textContent =
      displayName("R") + " (Red) vs " + displayName("B") + " (Blue)";
    let detail = gameResult.detail;
    if (seriesMatch && !finalResult) {
      detail +=
        " Next game: " + startLabel("B") + " as Red.";
    }
    dom.endDetail.textContent = detail;

    if (seriesMatch) {
      dom.endSeries.hidden = false;
      dom.endSeries.textContent =
        (finalResult ? "Final series: " : "Series: ") + seriesLabel();
    } else {
      dom.endSeries.hidden = true;
      dom.endSeries.textContent = "";
    }

    dom.endScore.textContent =
      "All-time wins — " +
      displayName(colorForPlayer("P1")) +
      ": " +
      scores.P1 +
      " · " +
      displayName(colorForPlayer("P2")) +
      ": " +
      scores.P2;

    dom.btnAgain.hidden = seriesMatch;
    dom.btnNextGame.hidden = !seriesMatch || finalResult;
    dom.btnNewMatch.hidden = !seriesMatch || !finalResult;
    dom.btnViewReplay.hidden = !lastReplay;
    dom.btnExportEnd.hidden = !lastReplay;
  }

  function scheduleReveal(duration) {
    const ticket = epoch;
    window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(
      function () {
        if (ticket !== epoch) return;
        playSound("win");
        if (statsOpen) {
          statsPendingEnd = true;
          return;
        }
        showScreen("screen-end");
      },
      Math.max(0, duration) + 90
    );
  }

  function announceMove(record, result) {
    let text = displayName(record.player) + " played " + record.notation + ".";
    if (result) {
      text +=
        " " + (result.winner ? winSentence(result.winner) : "The game is a draw.");
    } else if (isVsComputer() && currentPlayer === humanSide()) {
      text += " Your turn.";
    } else {
      text += " " + displayName(currentPlayer) + " to move.";
    }
    announce(text);
  }

  /* ------------------------------------------------------------------ */
  /* Interaction                                                        */
  /* ------------------------------------------------------------------ */

  function handleSquareClick(row, col) {
    if (humanInputBlocked()) return;

    const target = legalMoves.find((move) => move.row === row && move.col === col);

    if (selectedPiece && target) {
      if (target.capture) {
        applyCaptureHop(row, col);
      } else {
        executeMove(selectedPiece.row, selectedPiece.col, row, col);
      }
      return;
    }

    // During a capture chain the player must keep jumping; other clicks are
    // ignored so the mandatory continuation cannot be abandoned.
    if (chainPath.length > 0) {
      if (isPlayableSquare(row, col)) playSound("invalid");
      return;
    }

    if (selectedPiece) {
      if (selectedPiece.row === row && selectedPiece.col === col) {
        clearSelection();
        refreshUI();
        return;
      }
      if (isOwnPiece(row, col, currentPlayer)) {
        if (selectPiece(row, col)) {
          refreshUI();
        } else {
          playSound("invalid");
        }
        return;
      }
      if (isPlayableSquare(row, col) && board[row][col]) {
        playSound("invalid");
      }
      return;
    }

    if (selectPiece(row, col)) {
      refreshUI();
    } else if (
      isPlayableSquare(row, col) &&
      board[row][col] &&
      pieceColor(board[row][col]) !== currentPlayer
    ) {
      playSound("invalid");
    }
  }

  function handleBoardKeydown(event) {
    const direction = playerColors.P1 === "B" ? -1 : 1;
    const deltas = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };

    if (event.key === "Home") {
      event.preventDefault();
      focusBoardSquare(direction === -1 ? BOARD_SIZE - 1 : 0,
        direction === -1 ? BOARD_SIZE - 1 : 0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusBoardSquare(direction === -1 ? 0 : BOARD_SIZE - 1,
        direction === -1 ? 0 : BOARD_SIZE - 1);
      return;
    }

    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const row = Math.min(BOARD_SIZE - 1, Math.max(0, focusedSquare.row + delta[0] * direction));
    const col = Math.min(BOARD_SIZE - 1, Math.max(0, focusedSquare.col + delta[1] * direction));
    focusBoardSquare(row, col);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function createPieceElement(piece) {
    const element = document.createElement("span");
    element.className =
      "piece " + (pieceColor(piece) === "R" ? "piece--red" : "piece--blue");
    element.setAttribute("aria-hidden", "true");

    if (isDama(piece)) {
      element.classList.add("piece--dama");
      const crown = document.createElement("span");
      crown.className = "crown";
      crown.setAttribute("aria-hidden", "true");
      crown.textContent = "\u265B";
      element.appendChild(crown);
    }

    return element;
  }

  function describeSquare(row, col, piece, playable, flags) {
    const file = String.fromCharCode(65 + col);
    const rank = BOARD_SIZE - row;
    let text = file + rank + ", " + (playable ? "dark" : "light") + " square";

    if (!piece) {
      text += ", empty";
    } else {
      text +=
        ", " +
        COLOR_NAMES[pieceColor(piece)] +
        " " +
        (isDama(piece) ? "Dama" : "piece");
    }

    if (flags.selected) text += ", selected";
    if (flags.capture) text += ", capture landing square";
    else if (flags.move) text += ", legal move";
    if (flags.mandatory) text += ", must capture";
    return text;
  }

  function renderBoard() {
    const redRemaining = countPieces("R");
    const blueRemaining = countPieces("B");

    dom.redRemaining.textContent = String(redRemaining);
    dom.blueRemaining.textContent = String(blueRemaining);
    dom.redCaptured.textContent = String(12 - blueRemaining);
    dom.blueCaptured.textContent = String(12 - redRemaining);

    const active = activePieceSquare();
    const selectedKey = active ? active.row + "," + active.col : null;
    const moveKeys = new Set(legalMoves.map((move) => move.row + "," + move.col));
    const captureKeys = new Set(
      legalMoves.filter((move) => move.capture).map((move) => move.row + "," + move.col)
    );
    const mandatoryKeys = new Set(
      mandatoryCapturePieces.map((piece) => piece.row + "," + piece.col)
    );
    const lastKeys = new Set(
      lastMove ? lastMove.path.map((step) => step.row + "," + step.col) : []
    );

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const square = squareEls[row][col];
        const key = row + "," + col;
        const playable = isPlayableSquare(row, col);
        const piece = board[row][col];
        const isSelected = selectedKey === key;
        const isMove = moveKeys.has(key);
        const isCapture = captureKeys.has(key);
        const isMandatory =
          mandatoryKeys.has(key) &&
          !gameOver &&
          !isSelected &&
          chainPath.length === 0;

        square.className = "square " + (playable ? "dark" : "light");
        if (isSelected) square.classList.add("is-selected");
        if (isMove) square.classList.add(isCapture ? "is-capture" : "is-move");
        if (isMandatory) square.classList.add("is-mandatory");
        if (lastKeys.has(key)) square.classList.add("is-last");

        square.replaceChildren();
        if (piece) square.appendChild(createPieceElement(piece));

        square.setAttribute(
          "aria-label",
          describeSquare(row, col, piece, playable, {
            selected: isSelected,
            move: isMove && !isCapture,
            capture: isCapture,
            mandatory: isMandatory,
          })
        );
        square.tabIndex =
          focusedSquare.row === row && focusedSquare.col === col ? 0 : -1;
      }
    }
  }

  function applyReplayRecord(source, record) {
    const next = source.map(function (line) {
      return line.slice();
    });
    if (!record.from || !record.to) return next;
    const piece = next[record.from.row][record.from.col] || record.piece;
    if (!piece) return next;
    next[record.from.row][record.from.col] = null;
    for (const captured of record.capturedSquares || []) {
      if (insideBoard(captured.row, captured.col)) {
        next[captured.row][captured.col] = null;
      }
    }
    next[record.to.row][record.to.col] = record.promoted
      ? promotePiece(piece)
      : piece;
    return next;
  }

  function replayBoardAt(data, moveIndex) {
    let next = data.initialBoard.map(function (line) {
      return line.slice();
    });
    const limit = Math.min(moveIndex, data.moves.length);
    for (let index = 0; index < limit; index++) {
      next = applyReplayRecord(next, data.moves[index]);
    }
    return next;
  }

  function replayModeLabel(data) {
    let label = data.mode === "online" ? "Online" : data.mode === "vsComputer" ? "vs Computer" : "2-player";
    if (data.difficulty) {
      label += " · " + data.difficulty.charAt(0).toUpperCase() + data.difficulty.slice(1);
    }
    const formatLabel =
      matchFormatLabel(data.format) +
      (data.format === "single" ? "" : " · Game " + data.gameNumber);
    return formatLabel + " · " + label +
      (data.version === REPLAY_VERSION
        ? " · Red: " + data.players.R + " · Blue: " + data.players.B
        : "");
  }

  function isReplayScreenOpen() {
    const screen = document.getElementById("screen-replay");
    return Boolean(screen && !screen.hidden);
  }

  function renderReplay() {
    if (!replayState || !replayState.data) return;
    const data = replayState.data;
    const index = Math.max(0, Math.min(replayState.index, data.moves.length));
    const shownBoard = replayBoardAt(data, index);
    const currentRecord = index > 0 ? data.moves[index - 1] : null;
    const lastKeys = new Set(
      currentRecord
        ? currentRecord.path.map(function (step) {
            return step.row + "," + step.col;
          })
        : []
    );

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const square = replaySquareEls[row][col];
        const playable = isPlayableSquare(row, col);
        const piece = shownBoard[row][col];
        const key = row + "," + col;
        square.className = "square replay-square " + (playable ? "dark" : "light");
        if (lastKeys.has(key)) square.classList.add("is-last");
        square.replaceChildren();
        if (piece) square.appendChild(createPieceElement(piece));
        square.setAttribute(
          "aria-label",
          describeSquare(row, col, piece, playable, {})
        );
      }
    }

    dom.replayMeta.textContent = replayModeLabel(data);
    dom.replayResult.textContent =
      data.result.title + (data.result.detail ? " · " + data.result.detail : "");
    dom.replayExportDate.hidden = !replayState.exportedAt;
    if (replayState.exportedAt) {
      dom.replayExportDate.textContent =
        "Exported: " + new Date(replayState.exportedAt).toLocaleString();
    }
    dom.replayCounter.textContent = "Move " + index + " / " + data.moves.length;
    dom.replayDescription.textContent = currentRecord
      ? data.players[currentRecord.player] +
        " played " +
        currentRecord.notation +
        "."
      : "Starting position.";
    dom.btnReplayPrev.disabled = index <= 0;
    dom.btnReplayNext.disabled = index >= data.moves.length;
    dom.btnReplayRestart.disabled = index <= 0;
    dom.btnReplayPlay.disabled = data.moves.length === 0;
    dom.btnReplayPlay.textContent = replayTimer ? "Pause" : "Play";
    dom.btnReplayPlay.setAttribute("aria-pressed", replayTimer ? "true" : "false");
  }

  function stopReplayPlayback() {
    if (replayTimer) {
      window.clearInterval(replayTimer);
      replayTimer = 0;
    }
    if (dom.btnReplayPlay) {
      dom.btnReplayPlay.textContent = "Play";
      dom.btnReplayPlay.setAttribute("aria-pressed", "false");
    }
  }

  function setReplayIndex(nextIndex) {
    if (!replayState) return;
    replayState.index = Math.max(
      0,
      Math.min(nextIndex, replayState.data.moves.length)
    );
    renderReplay();
  }

  function stepReplay(delta) {
    if (!replayState) return;
    stopReplayPlayback();
    setReplayIndex(replayState.index + delta);
  }

  function replayRestart() {
    if (!replayState) return;
    stopReplayPlayback();
    setReplayIndex(0);
  }

  function startReplayPlayback() {
    if (!replayState || replayState.data.moves.length === 0) return;
    stopReplayPlayback();
    if (replayState.index >= replayState.data.moves.length) {
      setReplayIndex(0);
    }
    replayTimer = window.setInterval(function () {
      if (!replayState) {
        stopReplayPlayback();
        return;
      }
      if (replayState.index >= replayState.data.moves.length) {
        stopReplayPlayback();
        renderReplay();
        return;
      }
      setReplayIndex(replayState.index + 1);
      if (replayState.index >= replayState.data.moves.length) {
        stopReplayPlayback();
        renderReplay();
      }
    }, REPLAY_STEP_MS);
    renderReplay();
  }

  function toggleReplayPlayback() {
    if (!replayState) return;
    if (replayTimer) stopReplayPlayback();
    else startReplayPlayback();
    renderReplay();
  }

  function openReplayData(data, returnScreen, exportedAt, view) {
    stopReplayPlayback();
    replayState = {
      data,
      index: 0,
      returnScreen: returnScreen || "screen-title",
      exportedAt: exportedAt || null,
      view: view || null,
    };
    setBoardOrientation(
      dom.replayBoard,
      replaySquareEls,
      dom.replayFiles,
      dom.replayRanks,
      view ? view === "blue-bottom" :
        data.version >= 2 && data.colors.P1 === "B",
      true
    );
    renderReplay();
    showScreen("screen-replay");
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }

  function openReplay(returnScreen) {
    if (!lastReplay) {
      showReplayStatus("No saved replay yet.", true);
      return;
    }
    openReplayData(lastReplay, returnScreen);
  }

  function showReplayStatus(message, error = false) {
    window.clearTimeout(replayStatusTimer);
    dom.replayStatus.textContent = message;
    dom.replayStatus.classList.toggle("is-error", error);
    dom.replayStatus.hidden = false;
    replayStatusTimer = window.setTimeout(function () {
      dom.replayStatus.hidden = true;
    }, 5000);
  }

  function exportReplay() {
    const source = isReplayScreenOpen() && replayState
      ? replayState.data
      : lastReplay;
    if (!source) {
      showReplayStatus("No replay available to export.", true);
      return false;
    }
    let objectUrl = null;
    let link = null;
    try {
      const file = serializeReplay(
        source,
        new Date().toISOString(),
        isReplayScreenOpen() && replayState ? replayState.view : null
      );
      const blob = new Blob([JSON.stringify(file, null, 2) + "\n"], {
        type: "application/json",
      });
      objectUrl = URL.createObjectURL(blob);
      link = document.createElement("a");
      link.href = objectUrl;
      link.download = "dama-pinoy-replay-" + file.exportedAt.slice(0, 10) +
        "-" + file.exportedAt.slice(11, 19).replace(/:/g, "") + ".json";
      document.body.appendChild(link);
      link.click();
      window.setTimeout(function () {
        link.remove();
        URL.revokeObjectURL(objectUrl);
      }, 30000);
      showReplayStatus("Replay exported successfully.");
      return true;
    } catch (error) {
      if (link) link.remove();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      showReplayStatus("Could not export this replay.", true);
      return false;
    }
  }

  function readReplayFile(file) {
    if (typeof file.text === "function") return file.text();
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  async function importReplay(file) {
    const returnScreen = isReplayScreenOpen() && replayState
      ? replayState.returnScreen
      : "screen-title";
    try {
      if (!file || !/\.json$/i.test(file.name) ||
        !Number.isFinite(file.size) || file.size < 0 ||
          file.size > REPLAY_FILE_MAX_BYTES) {
        invalidReplayFile();
      }
      const contents = await readReplayFile(file);
      const imported = deserializeReplay(JSON.parse(contents));
      openReplayData(
        imported.data, returnScreen, imported.exportedAt, imported.view
      );
      showReplayStatus("Replay imported successfully.");
      return true;
    } catch (error) {
      showReplayStatus(
        "Invalid replay file. Please select a Dama Pinoy replay exported from this game.",
        true
      );
      return false;
    }
  }

  function exitReplay() {
    if (!replayState) return;
    stopReplayPlayback();
    const returnScreen = replayState.returnScreen || "screen-title";
    replayState = null;
    showScreen(returnScreen);
    if (typeof window.scrollTo === "function") window.scrollTo(0, 0);
  }

  function handleReplayKeydown(event) {
    if (!isReplayScreenOpen() || !replayState) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === "Escape") {
      event.preventDefault();
      exitReplay();
      return;
    }

    if (event.key === " " || event.key === "Spacebar") {
      if (event.repeat) return;
      if (event.target && event.target.closest && event.target.closest("button")) {
        return;
      }
      event.preventDefault();
      toggleReplayPlayback();
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepReplay(-1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      stepReplay(1);
    }
  }

  function updateStatus() {
    const vsComputer = isVsComputer();
    const thinking =
      vsComputer && !gameOver && (aiThinking || aiApplying) && isAiTurn();
    const humanTurn = vsComputer && currentPlayer === humanSide() && !gameOver;
    const label = displayName(currentPlayer);

    dom.turnPill.classList.toggle("is-thinking", thinking);
    dom.board.setAttribute("aria-busy", thinking ? "true" : "false");
    dom.turnDot.classList.toggle("is-blue", currentPlayer === "B" && !thinking);
    dom.turnText.textContent = gameOver
      ? "Game over"
      : thinking
        ? aiApplying
          ? "Computer is moving…"
          : "Computer is thinking…"
        : humanTurn
          ? "Your turn"
          : label + " to move";
    dom.playerRed.classList.toggle("is-active", !gameOver && currentPlayer === "R");
    dom.playerBlue.classList.toggle("is-active", !gameOver && currentPlayer === "B");

    if (gameOver) {
      dom.statusText.textContent = gameResult
        ? gameResult.winner
          ? winSentence(gameResult.winner)
          : "The game is a draw."
        : "Game over.";
      return;
    }
    if (thinking) {
      dom.statusText.textContent = aiApplying
        ? "Computer is moving…"
        : "Computer is thinking…";
      return;
    }
    if (chainPath.length > 0) {
      dom.statusText.textContent = humanTurn
        ? "You must continue the capture chain."
        : label + " must continue the capture chain.";
      return;
    }
    if (turnBestChains.length > 0) {
      dom.statusText.textContent = humanTurn
        ? "You must capture — only the longest capture chain is allowed."
        : label + " must capture — only the longest capture chain is allowed.";
      return;
    }
    dom.statusText.textContent = humanTurn ? "Your turn." : label + " to move.";
  }

  function renderHistory() {
    if (!dom.moveList) return;
    if (moveHistory.length === 0) {
      dom.moveList.replaceChildren();
      dom.historyEmpty.hidden = false;
      return;
    }

    dom.historyEmpty.hidden = true;
    const fragment = document.createDocumentFragment();

    moveHistory.forEach(function (record, index) {
      const item = document.createElement("li");
      item.className = "move move--" + (record.player === "R" ? "red" : "blue");

      const number = document.createElement("span");
      number.className = "move-number";
      number.textContent = index + 1 + ".";

      const player = document.createElement("span");
      player.className = "move-player";
      player.textContent = COLOR_NAMES[record.player];

      const notation = document.createElement("span");
      notation.className = "move-notation";
      notation.textContent = record.notation;

      item.append(number, player, notation);
      fragment.appendChild(item);
    });

    dom.moveList.replaceChildren(fragment);
    dom.moveList.scrollTop = dom.moveList.scrollHeight;
  }

  function renderScores() {
    dom.redWins.textContent = String(scores[playerForColor("R")]);
    dom.blueWins.textContent = String(scores[playerForColor("B")]);
  }

  function resetScoreboard() {
    scores = { P1: 0, P2: 0 };
    saveScores();
    renderScores();
    if (gameResult) updateEndStateText();
  }

  function updateControls() {
    if (!dom.btnUndo) return;
    const canUndo =
      !gameOver &&
      !isAnimating &&
      !aiThinking &&
      !aiApplying &&
      !isAiTurn() &&
      chainPath.length === 0 &&
      gameHistory.length > 0 &&
      (!isVsComputer() || gameHistory.some(function (state) {
        return state.currentPlayer === humanSide();
      }));
    dom.btnUndo.disabled = !canUndo;
    dom.btnUndo.setAttribute("aria-disabled", canUndo ? "false" : "true");
    dom.btnUndo.title = canUndo
      ? "Undo the last completed turn"
      : gameHistory.length === 0
        ? "No move to undo"
        : "Undo is unavailable right now";
  }

  function refreshUI() {
    renderBoard();
    updateStatus();
    renderHistory();
    updateControls();
  }

  function syncTabIndex() {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        squareEls[row][col].tabIndex =
          focusedSquare.row === row && focusedSquare.col === col ? 0 : -1;
      }
    }
  }

  function focusBoardSquare(row, col) {
    focusedSquare = { row, col };
    syncTabIndex();
    const square = squareEls[row] && squareEls[row][col];
    if (square) square.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* Animations                                                         */
  /* ------------------------------------------------------------------ */

  function createGhost(captured) {
    const square = squareEls[captured.row] && squareEls[captured.row][captured.col];
    if (!square || !captured.piece) return null;
    const ghost = createPieceElement(captured.piece);
    ghost.classList.add("piece--ghost");
    square.appendChild(ghost);
    return ghost;
  }

  function pulsePromotion(position) {
    const square = squareEls[position.row] && squareEls[position.row][position.col];
    if (!square) return;
    square.classList.add("is-promoting");
    const ticket = epoch;
    window.setTimeout(function () {
      if (ticket === epoch) square.classList.remove("is-promoting");
    }, PROMOTION_ANIM_MS + 60);
  }

  function runAnimation(animation) {
    if (!animation) return 0;

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduceMotion
      ? 0
      : animation.captured
        ? CAPTURE_ANIM_MS
        : MOVE_ANIM_MS;

    if (duration === 0) return 0;

    const fromSquare =
      squareEls[animation.from.row] && squareEls[animation.from.row][animation.from.col];
    const toSquare =
      squareEls[animation.to.row] && squareEls[animation.to.row][animation.to.col];
    if (!fromSquare || !toSquare) return 0;

    const pieceElement = toSquare.querySelector(".piece");
    if (!pieceElement || typeof pieceElement.animate !== "function") return 0;

    const fromRect = fromSquare.getBoundingClientRect();
    const toRect = toSquare.getBoundingClientRect();
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;
    const lift = animation.captured ? Math.min(20, toRect.width * 0.2) : 0;

    const keyframes = animation.captured
      ? [
          { transform: "translate(" + dx + "px, " + dy + "px)" },
          {
            transform:
              "translate(" + dx / 2 + "px, " + (dy / 2 - lift) + "px) scale(1.04)",
            offset: 0.5,
          },
          { transform: "translate(0, 0) scale(1)" },
        ]
      : [
          { transform: "translate(" + dx + "px, " + dy + "px)" },
          { transform: "translate(0, 0)" },
        ];

    const ghost = animation.captured ? createGhost(animation.captured) : null;
    const ticket = epoch;
    isAnimating = true;
    updateControls();

    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      if (ghost) ghost.remove();
      if (ticket !== epoch) return;
      isAnimating = false;
      if (animation.promoted) pulsePromotion(animation.to);
      updateControls();
    }

    try {
      const motion = pieceElement.animate(keyframes, {
        duration,
        easing: animation.captured
          ? "cubic-bezier(.22, .9, .3, 1)"
          : "cubic-bezier(.2, .8, .3, 1)",
      });
      motion.addEventListener("finish", settle);
      motion.addEventListener("cancel", settle);
    } catch (error) {
      settle();
      return 0;
    }

    window.setTimeout(settle, duration + 90);
    return duration;
  }

  /* ------------------------------------------------------------------ */
  /* Confirm dialog                                                     */
  /* ------------------------------------------------------------------ */

  function openConfirm(options) {
    pendingConfirm = options.onConfirm;
    confirmOpener = document.activeElement;

    dom.confirmTitle.textContent = options.title;
    dom.confirmMessage.textContent = options.message;
    dom.confirmOk.textContent = options.confirmLabel || "Confirm";
    dom.confirmOk.classList.toggle("btn--danger", options.danger !== false);
    dom.confirmOk.classList.toggle("btn--primary", options.danger === false);

    if (typeof dom.confirmDialog.showModal !== "function") {
      pendingConfirm = null;
      if (window.confirm(options.title + "\n\n" + options.message)) {
        options.onConfirm();
      }
      return;
    }

    try {
      dom.confirmDialog.returnValue = "";
      dom.confirmDialog.showModal();
      dom.confirmCancel.focus();
    } catch (error) {
      pendingConfirm = null;
      if (window.confirm(options.message)) options.onConfirm();
    }
  }

  function closeConfirm(value) {
    if (!dom.confirmDialog.open) return;
    dom.confirmDialog.close(value);
  }

  function handleConfirmClose() {
    const confirmed = dom.confirmDialog.returnValue === "confirm";
    const action = pendingConfirm;
    const opener = confirmOpener;
    pendingConfirm = null;
    confirmOpener = null;

    if (confirmed && action) {
      window.setTimeout(action, 0);
      return;
    }

    if (opener && typeof opener.focus === "function" && opener.isConnected) {
      window.setTimeout(function () {
        opener.focus({ preventScroll: true });
      }, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Screens and setup                                                  */
  /* ------------------------------------------------------------------ */

  function showScreen(screenId) {
    for (const section of dom.screens) {
      const active = section.id === screenId;
      section.hidden = !active;
      section.setAttribute("aria-hidden", active ? "false" : "true");
    }
    const target = document.getElementById(screenId);
    if (!target) return;
    const focusTarget = target.querySelector("[data-autofocus], h1, h2");
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  function resetGameState(starter) {
    epoch += 1;
    window.clearTimeout(revealTimer);
    revealTimer = 0;
    cancelAiTurn();
    stopReplayPlayback();
    isAnimating = false;
    statsRecordedForGame = false;
    statsOpen = false;
    statsPendingEnd = false;

    board = createInitialBoard();
    currentPlayer = starter === "B" ? "B" : "R";
    movesWithoutCaptureOrPromotion = 0;
    gameOver = false;
    gameResult = null;
    lastMove = null;
    moveHistory = [];
    gameHistory = [];
    turnStartState = null;
    turnCapturedSquares = [];

    clearSelection();
    turnBestChains = [];
    mandatoryCapturePieces = [];
    focusedSquare = { ...START_FOCUS_BY_PLAYER[currentPlayer] };
    setBoardOrientation(
      dom.board,
      squareEls,
      dom.gameFiles,
      dom.gameRanks,
      playerColors.P1 === "B",
      false
    );

    dom.endCard.classList.remove("winner-red", "winner-blue", "winner-draw");
    if (dom.historyEmpty) {
      dom.historyEmpty.textContent =
        "No moves yet. " + startLabel(currentPlayer) + ".";
    }
    startTurn();
    renderMatchStrip();
    refreshUI();
  }

  function renderMatchStrip() {
    if (!dom.matchStrip) return;
    const active = isSeriesMatch() && !gameOver;
    dom.matchStrip.hidden = !isSeriesMatch();
    if (!isSeriesMatch()) return;
    dom.matchGameLabel.textContent =
      "Game " + currentGameNumber + " of " + matchGameLimit();
    dom.matchStartLabel.textContent = startLabel("R") + " (Red)";
    dom.matchSeriesLabel.textContent = seriesLabel();
    dom.matchStrip.classList.toggle("is-live", active);
  }

  function startSelectedMatch() {
    startMatch();
  }

  function startMatch() {
    stopReplayPlayback();
    seriesScores = { P1: 0, P2: 0 };
    currentGameNumber = 1;
    matchWinner = null;
    startingPlayer = "R";
    matchDifficulty = aiDifficulty;
    seriesStatsRecorded = false;
    startCurrentGame();
  }

  function startCurrentGame() {
    setGameColors();
    startingPlayer = "R";
    applyModeLabels();
    renderScores();
    resetGameState("R");
    showScreen("screen-game");
    const focusColor = isVsComputer() ? humanSide() : "R";
    focusBoardSquare(
      START_FOCUS_BY_PLAYER[focusColor].row,
      START_FOCUS_BY_PLAYER[focusColor].col
    );
    if (isAiTurn()) scheduleAiTurn(0);
  }

  function startNextMatchGame() {
    if (!isSeriesMatch() || matchWinner || currentGameNumber >= matchGameLimit()) return;
    currentGameNumber += 1;
    startCurrentGame();
  }

  function startNewGame() {
    currentGameNumber = 1;
    startCurrentGame();
  }

  function undoMove() {
    if (gameOver || isAnimating || chainPath.length > 0 || gameHistory.length === 0) {
      return;
    }

    cancelAiTurn();
    let previous = gameHistory.pop();
    if (
      isVsComputer() &&
      previous &&
      previous.currentPlayer === aiSide() &&
      gameHistory.length > 0 &&
      gameHistory[gameHistory.length - 1].currentPlayer === humanSide()
    ) {
      previous = gameHistory.pop();
    }
    if (!previous) return;

    epoch += 1;
    window.clearTimeout(revealTimer);
    revealTimer = 0;

    board = previous.board.map(function (line) {
      return line.slice();
    });
    currentPlayer = previous.currentPlayer;
    movesWithoutCaptureOrPromotion = previous.movesWithoutCaptureOrPromotion;
    lastMove = previous.lastMove
      ? { path: clonePath(previous.lastMove.path), capture: previous.lastMove.capture }
      : null;
    moveHistory = previous.moveHistory.map(cloneMoveRecord);
    gameOver = false;
    gameResult = null;
    isAnimating = false;

    clearSelection();
    turnBestChains = [];
    mandatoryCapturePieces = [];
    startTurn();
    refreshUI();
    announce("Move undone. " + displayName(currentPlayer) + " to move.");
  }

  function leaveToMenu() {
    epoch += 1;
    window.clearTimeout(revealTimer);
    revealTimer = 0;
    cancelAiTurn();
    isAnimating = false;
    updateControls();
    showScreen("screen-title");
  }

  function requestNewGame() {
    if (isSeriesMatch()) {
      openConfirm({
        title: "Restart this match?",
        message:
          "The series score and board will be reset to Game 1. All-time win counts, names, themes, and sound are kept.",
        confirmLabel: "Restart Match",
        onConfirm: startMatch,
      });
      return;
    }
    openConfirm({
      title: "Start a new game?",
      message:
        "The board, turn, move history, and win counters will be reset. Player names, themes, and sound are kept.",
      confirmLabel: "Start New Game",
      onConfirm: function () {
        resetScoreboard();
        startNewGame();
      },
    });
  }

  function requestMainMenu() {
    if (gameOver || moveHistory.length === 0) {
      leaveToMenu();
      return;
    }
    openConfirm({
      title: "Leave this game?",
      message:
        "Your current game will be discarded. Win counts and preferences are kept.",
      confirmLabel: "Leave Game",
      onConfirm: leaveToMenu,
    });
  }

  function requestResetScores() {
    openConfirm({
      title: "Reset scores?",
      message: "Both win counters will return to zero. The current game is not affected.",
      confirmLabel: "Reset Scores",
      onConfirm: function () {
        resetScoreboard();
        announce("Scores reset.");
      },
    });
  }

  function bindNameInput(player, input) {
    input.addEventListener("input", function () {
      if (input.readOnly) return;
      names[playerForColor(player)] = input.value.slice(0, 20);
      updateStatus();
      if (gameOver && gameResult) updateEndStateText();
      saveNames();
    });

    input.addEventListener("blur", function () {
      if (input.readOnly) return;
      const trimmed = input.value.trim();
      if (isVsComputer() && playerForColor(player) === "P1") {
        const shown =
          !trimmed || trimmed === DEFAULT_NAMES.P1 || trimmed === HUMAN_DEFAULT_LABEL
            ? HUMAN_DEFAULT_LABEL
            : trimmed;
        names.P1 = shown === HUMAN_DEFAULT_LABEL ? DEFAULT_NAMES.P1 : shown;
        input.value = shown;
      } else {
        const id = playerForColor(player);
        names[id] = trimmed || DEFAULT_NAMES[id];
        input.value = names[id];
      }
      saveNames();
      updateStatus();
      if (gameOver && gameResult) updateEndStateText();
    });
  }

  function buildBoard() {
    dom.board.replaceChildren();
    for (let row = 0; row < BOARD_SIZE; row++) {
      squareEls[row] = [];
      for (let col = 0; col < BOARD_SIZE; col++) {
        const square = document.createElement("button");
        square.type = "button";
        square.className = "square";
        square.dataset.row = String(row);
        square.dataset.col = String(col);

        square.addEventListener("click", () => {
          focusedSquare = { row, col };
          handleSquareClick(row, col);
        });
        square.addEventListener("focus", () => {
          focusedSquare = { row, col };
          syncTabIndex();
        });

        dom.board.appendChild(square);
        squareEls[row][col] = square;
      }
    }
    dom.board.addEventListener("keydown", handleBoardKeydown);
  }

  function buildReplayBoard() {
    dom.replayBoard.replaceChildren();
    for (let row = 0; row < BOARD_SIZE; row++) {
      replaySquareEls[row] = [];
      for (let col = 0; col < BOARD_SIZE; col++) {
        const square = document.createElement("div");
        square.className = "square replay-square";
        square.setAttribute("role", "gridcell");
        square.dataset.row = String(row);
        square.dataset.col = String(col);
        dom.replayBoard.appendChild(square);
        replaySquareEls[row][col] = square;
      }
    }
  }

  function cacheDom() {
    dom.screens = Array.from(document.querySelectorAll(".screen"));
    dom.board = document.getElementById("board");
    dom.gameFiles = document.getElementById("game-files");
    dom.gameRanks = document.getElementById("game-ranks");
    dom.statusText = document.getElementById("status-text");
    dom.turnPill = document.getElementById("turn-indicator");
    dom.turnText = document.getElementById("turn-text");
    dom.turnDot = document.getElementById("turn-dot");
    dom.modeRadios = Array.from(
      document.querySelectorAll('input[name="game-mode"]')
    );
    dom.formatRadios = Array.from(
      document.querySelectorAll('input[name="match-format"]')
    );
    dom.colorRadios = Array.from(
      document.querySelectorAll('input[name="player-color"]')
    );
    dom.colorLegend = document.getElementById("color-legend");
    dom.btnStart = document.getElementById("btn-start");
    dom.btnLastReplay = document.getElementById("btn-last-replay");
    dom.btnImportTitle = document.getElementById("btn-import-replay");
    dom.replayFileInput = document.getElementById("replay-file-input");
    dom.replayStatus = document.getElementById("replay-transfer-status");
    dom.matchStrip = document.getElementById("match-strip");
    dom.matchGameLabel = document.getElementById("match-game-label");
    dom.matchStartLabel = document.getElementById("match-start-label");
    dom.matchSeriesLabel = document.getElementById("match-series-label");
    dom.difficultyField = document.getElementById("difficulty-field");
    dom.aiDifficulty = document.getElementById("ai-difficulty");
    dom.redRole = document.getElementById("red-role");
    dom.blueRole = document.getElementById("blue-role");
    dom.playerRed = document.getElementById("player-red");
    dom.playerBlue = document.getElementById("player-blue");
    dom.redRemaining = document.getElementById("red-remaining");
    dom.blueRemaining = document.getElementById("blue-remaining");
    dom.redCaptured = document.getElementById("red-captured");
    dom.blueCaptured = document.getElementById("blue-captured");
    dom.redWins = document.getElementById("red-wins");
    dom.blueWins = document.getElementById("blue-wins");
    dom.nameRed = document.getElementById("name-red");
    dom.nameBlue = document.getElementById("name-blue");
    dom.themeSelect = document.getElementById("theme-select");
    dom.btnSound = document.getElementById("btn-sound");
    dom.soundLabel = document.getElementById("sound-label");
    dom.btnUndo = document.getElementById("btn-undo");
    dom.btnRestart = document.getElementById("btn-restart");
    dom.btnMenu = document.getElementById("btn-menu");
    dom.btnAgain = document.getElementById("btn-again");
    dom.btnEndMenu = document.getElementById("btn-end-menu");
    dom.btnResetScores = document.getElementById("btn-reset-scores");
    dom.btnStats = document.getElementById("btn-stats");
    dom.btnGameStats = document.getElementById("btn-game-stats");
    dom.btnStatsBack = document.getElementById("btn-stats-back");
    dom.btnResetStats = document.getElementById("btn-reset-stats");
    dom.statsContent = document.getElementById("stats-content");
    dom.statsEmpty = document.getElementById("stats-empty");
    dom.statValues = {};
    document.querySelectorAll("[data-stat]").forEach(function (element) {
      dom.statValues[element.getAttribute("data-stat")] = element;
    });
    dom.historyEmpty = document.getElementById("history-empty");
    dom.moveList = document.getElementById("move-history");
    dom.announcer = document.getElementById("announcer");
    dom.endEyebrow = document.getElementById("end-eyebrow");
    dom.endTitle = document.getElementById("end-title");
    dom.endDetail = document.getElementById("end-detail");
    dom.endMeta = document.getElementById("end-meta");
    dom.endSeries = document.getElementById("end-series");
    dom.endScore = document.getElementById("end-score");
    dom.endCard = document.getElementById("end-card");
    dom.btnAgain = document.getElementById("btn-again");
    dom.btnNextGame = document.getElementById("btn-next-game");
    dom.btnNewMatch = document.getElementById("btn-new-match");
    dom.btnViewReplay = document.getElementById("btn-view-replay");
    dom.btnExportEnd = document.getElementById("btn-export-end");
    dom.replayBoard = document.getElementById("replay-board");
    dom.replayFiles = document.getElementById("replay-files");
    dom.replayRanks = document.getElementById("replay-ranks");
    dom.replayHeading = document.getElementById("replay-heading");
    dom.replayMeta = document.getElementById("replay-meta");
    dom.replayResult = document.getElementById("replay-result");
    dom.replayExportDate = document.getElementById("replay-export-date");
    dom.replayCounter = document.getElementById("replay-counter");
    dom.replayDescription = document.getElementById("replay-description");
    dom.btnReplayPlay = document.getElementById("btn-replay-play");
    dom.btnReplayPrev = document.getElementById("btn-replay-prev");
    dom.btnReplayNext = document.getElementById("btn-replay-next");
    dom.btnReplayRestart = document.getElementById("btn-replay-restart");
    dom.btnReplayExit = document.getElementById("btn-replay-exit");
    dom.btnImportReplay = document.getElementById("btn-import-viewer");
    dom.btnExportReplay = document.getElementById("btn-export-viewer");
    dom.confirmDialog = document.getElementById("confirm-dialog");
    dom.confirmTitle = document.getElementById("confirm-title");
    dom.confirmMessage = document.getElementById("confirm-message");
    dom.confirmOk = document.getElementById("confirm-ok");
    dom.confirmCancel = document.getElementById("confirm-cancel");
  }

  function bindControls() {
    dom.btnStart.addEventListener("click", startSelectedMatch);
    document.getElementById("btn-howto").addEventListener("click", function () {
      showScreen("screen-howto");
    });
    document.getElementById("btn-howto-back").addEventListener("click", function () {
      showScreen("screen-title");
    });
    dom.btnLastReplay.addEventListener("click", function () {
      openReplay("screen-title");
    });
    dom.btnImportTitle.addEventListener("click", function () {
      dom.replayFileInput.click();
    });
    dom.replayFileInput.addEventListener("change", function () {
      const file = dom.replayFileInput.files[0];
      dom.replayFileInput.value = "";
      if (file) importReplay(file);
    });

    document.addEventListener("pointerdown", unlockAudio, { passive: true });
    document.addEventListener("keydown", unlockAudio);
    document.addEventListener("keydown", handleReplayKeydown);
    document.addEventListener("keydown", handleStatsKeydown);

    dom.btnUndo.addEventListener("click", undoMove);
    dom.btnRestart.addEventListener("click", requestNewGame);
    dom.btnMenu.addEventListener("click", requestMainMenu);
    dom.btnAgain.addEventListener("click", startNewGame);
    dom.btnNextGame.addEventListener("click", function () {
      startNextMatchGame();
    });
    dom.btnNewMatch.addEventListener("click", startMatch);
    dom.btnViewReplay.addEventListener("click", function () {
      openReplay("screen-end");
    });
    dom.btnExportEnd.addEventListener("click", exportReplay);
    dom.btnEndMenu.addEventListener("click", leaveToMenu);
    dom.btnResetScores.addEventListener("click", requestResetScores);
    if (dom.btnStats) {
      dom.btnStats.addEventListener("click", function () {
        openStats("screen-title");
      });
    }
    if (dom.btnGameStats) {
      dom.btnGameStats.addEventListener("click", function () {
        openStats("screen-game");
      });
    }
    if (dom.btnStatsBack) dom.btnStatsBack.addEventListener("click", closeStats);
    if (dom.btnResetStats) {
      dom.btnResetStats.addEventListener("click", requestResetStats);
    }

    dom.btnReplayPlay.addEventListener("click", toggleReplayPlayback);
    dom.btnReplayPrev.addEventListener("click", function () {
      stepReplay(-1);
    });
    dom.btnReplayNext.addEventListener("click", function () {
      stepReplay(1);
    });
    dom.btnReplayRestart.addEventListener("click", replayRestart);
    dom.btnReplayExit.addEventListener("click", exitReplay);
    dom.btnImportReplay.addEventListener("click", function () {
      dom.replayFileInput.click();
    });
    dom.btnExportReplay.addEventListener("click", exportReplay);

    dom.btnSound.addEventListener("click", function () {
      setSoundEnabled(!soundEnabled);
    });
    dom.themeSelect.addEventListener("change", function () {
      setTheme(dom.themeSelect.value);
    });

    bindNameInput("R", dom.nameRed);
    bindNameInput("B", dom.nameBlue);

    dom.modeRadios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        if (!radio.checked) return;
        gameMode =
          radio.value === "vsComputer" ? "vsComputer" : "twoPlayer";
        saveGameSettings();
        syncModeUI();
      });
    });
    dom.formatRadios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        if (!radio.checked) return;
        setMatchFormat(radio.value);
      });
    });
    dom.colorRadios.forEach(function (radio) {
      radio.addEventListener("change", function () {
        if (radio.checked) setStartColor(radio.value);
      });
    });
    dom.aiDifficulty.addEventListener("change", function () {
      aiDifficulty = AI_DIFFICULTIES.indexOf(dom.aiDifficulty.value) !== -1
        ? dom.aiDifficulty.value
        : "medium";
      saveGameSettings();
    });

    dom.confirmOk.addEventListener("click", function () {
      closeConfirm("confirm");
    });
    dom.confirmCancel.addEventListener("click", function () {
      closeConfirm("cancel");
    });
    dom.confirmDialog.addEventListener("close", handleConfirmClose);
    dom.confirmDialog.addEventListener("click", function (event) {
      if (event.target === dom.confirmDialog) closeConfirm("cancel");
    });
  }

  function syncPreferenceUI() {
    dom.themeSelect.value = currentTheme;
    renderScores();
    updateSoundUI();
    updateThemeMeta();
    syncModeUI();
  }

  function canRegisterServiceWorker() {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    if (protocol === "https:") return true;
    return (
      protocol === "http:" &&
      (host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1")
    );
  }

  function registerServiceWorker() {
    try {
      if (!canRegisterServiceWorker()) return;
      if (!("serviceWorker" in window.navigator)) return;
      const register = function () {
        window.navigator.serviceWorker
          .register("./service-worker.js")
          .catch(function () {});
      };
      if (document.readyState === "complete") register();
      else window.addEventListener("load", register);
    } catch (error) {
      /* Offline support is optional; the game still runs. */
    }
  }

  function init() {
    loadPreferences();
    loadStats();
    cacheDom();
    setGameColors();
    buildBoard();
    buildReplayBoard();
    loadSavedReplay();
    bindControls();
    syncPreferenceUI();
    renderStats();
    matchDifficulty = aiDifficulty;
    resetGameState("R");
    showScreen("screen-title");
    registerServiceWorker();
  }

  // The separate online client only needs the shared screen-navigation contract.
  globalThis.DamaPinoyApp = Object.freeze({ showScreen, openStats, refreshStats: renderStats,
    clearOnlineReplay() {
      if (replayState?.data.mode !== "online") return;
      stopReplayPlayback();
      replayState = null;
      if (isReplayScreenOpen()) showScreen("screen-account");
    },
    openOnlineReplay(file, download = false) {
      const imported = deserializeReplay(file);
      openReplayData(imported.data, "screen-online", imported.exportedAt, imported.view);
      if (download) return exportReplay();
      return true;
    },
  });

  if (globalThis.__DAMA_TEST__) {
    globalThis.DamaPinoyTest = {
      createInitialBoard,
      getNormalMoves,
      getCaptureMoves,
      getAllCaptureChains,
      getMandatoryCapturePieces,
      getBestCaptureChains,
      hasAnyLegalMove,
      isDama,
      evaluateGameState,
      getLegalMovesFor,
      applyMoveToBoard,
      chooseAiMove,
      evaluateBoard,
      scheduleAiTurn,
      getGameMode: () => gameMode,
      getDifficulty: () => aiDifficulty,
      setGameMode(nextMode) {
        if (GAME_MODES.indexOf(nextMode) === -1) return;
        gameMode = nextMode;
        saveGameSettings();
        syncModeUI();
      },
      setDifficulty(nextDifficulty) {
        if (AI_DIFFICULTIES.indexOf(nextDifficulty) === -1) return;
        aiDifficulty = nextDifficulty;
        saveGameSettings();
        syncModeUI();
      },
      isAiThinking: () => aiThinking,
      isAiApplying: () => aiApplying,
      setState(nextBoard, player, quietPlies = 0) {
        cancelAiTurn();
        board = nextBoard;
        currentPlayer = player;
        movesWithoutCaptureOrPromotion = quietPlies;
        gameOver = false;
      },
      loadPosition(nextBoard, player, quietPlies = 0) {
        epoch += 1;
        window.clearTimeout(revealTimer);
        revealTimer = 0;
        cancelAiTurn();
        isAnimating = false;
        board = nextBoard.map((line) => line.slice());
        currentPlayer = player;
        movesWithoutCaptureOrPromotion = quietPlies;
        gameOver = false;
        gameResult = null;
        lastMove = null;
        moveHistory = [];
        gameHistory = [];
        turnStartState = null;
        turnCapturedSquares = [];
        statsRecordedForGame = false;
        dom.endCard.classList.remove("winner-red", "winner-blue", "winner-draw");
        clearSelection();
        startTurn();
        refreshUI();
      },
      getBoard: () => board,
      getCurrentPlayer: () => currentPlayer,
      getMoveHistory: () => moveHistory.map(cloneMoveRecord),
      getScores: () => ({ R: scores.P1, B: scores.P2 }),
      getPlayerScores: () => ({ P1: scores.P1, P2: scores.P2 }),
      getStats: () => cloneStats(stats),
      getStatsStorageKey: () => STORAGE_KEYS.stats,
      calculateWinRate,
      loadStats,
      resetStats,
      openStats,
      closeStats,
      isStatsScreenOpen,
      getGameHistoryLength: () => gameHistory.length,
      getMatchFormat: () => matchFormat,
      setMatchFormat,
      getSeriesScores: () => ({ R: seriesScores.P1, B: seriesScores.P2 }),
      getPlayerSeriesScores: () => ({ P1: seriesScores.P1, P2: seriesScores.P2 }),
      getCurrentGameNumber: () => currentGameNumber,
      getStartingPlayer: () => startingPlayer,
      getGameOneColor: () => gameOneColor,
      getPlayerColors: () => ({ P1: playerColors.P1, P2: playerColors.P2 }),
      setStartColor,
      getMatchWinner: () => matchWinner,
      getMatchDifficulty: () => matchDifficulty,
      getLastReplay: () => lastReplay,
      getOpenReplay: () => replayState ? replayState.data : null,
      openReplay,
      exitReplay,
      serializeReplay,
      deserializeReplay,
      importReplay,
      exportReplay,
      getReplayIndex: () => (replayState ? replayState.index : null),
      stepReplay,
      toggleReplayPlayback,
      isReplayPlaying: () => Boolean(replayTimer),
      saveLastReplay,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
