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
  const START_FOCUS = { row: 5, col: 0 };

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
  let lastMove = null;
  let focusedSquare = { ...START_FOCUS };

  const dom = {};
  const squareEls = [];

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
  function getNormalMoves(row, col) {
    const piece = board[row][col];
    if (!piece) return [];
    const color = pieceColor(piece);
    const moves = [];

    if (isDama(piece)) {
      for (const [dr, dc] of DIAGONAL_DIRECTIONS) {
        let r = row + dr;
        let c = col + dc;
        while (insideBoard(r, c) && board[r][c] === null) {
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
      if (insideBoard(r, c) && board[r][c] === null) {
        moves.push({ row: r, col: c });
      }
    }
    return moves;
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
  // cannot loop forever. Reaching the promotion row ends the chain immediately.
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

        // A normal piece that reaches the far row promotes and the turn ends.
        if (!isDama(piece) && step.toRow === promotionRow(color)) {
          results.push({
            path: nextPath,
            captures: nextCaptures,
            promoted: true,
          });
          continue;
        }

        search(nextBoard, step.toRow, step.toCol, piece, nextPath, nextCaptures, nextVisited);
      }

      if (!tookStep && captures.length > 0) {
        results.push({ path, captures, promoted: false });
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
  /* Turn state                                                         */
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

  function startTurn() {
    turnBestChains = getBestCaptureChains(currentPlayer);
    mandatoryCapturePieces = [];
    const seen = new Set();
    for (const entry of turnBestChains) {
      const key = entry.row + "," + entry.col;
      if (seen.has(key)) continue;
      seen.add(key);
      mandatoryCapturePieces.push({ row: entry.row, col: entry.col });
    }
  }

  function selectPiece(row, col) {
    if (gameOver || !isPlayableSquare(row, col)) return false;
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

  function executeMove(fromRow, fromCol, toRow, toCol) {
    const piece = board[fromRow][fromCol];
    if (!piece) return;
    const allowed = getNormalMoves(fromRow, fromCol).some(
      (move) => move.row === toRow && move.col === toCol
    );
    if (!allowed) return;

    board[fromRow][fromCol] = null;
    board[toRow][toCol] = piece;
    lastMove = {
      path: [
        { row: fromRow, col: fromCol },
        { row: toRow, col: toCol },
      ],
      capture: false,
    };

    const promoted = promoteIfNeeded(toRow, toCol);
    finishTurn({ captured: false, promoted });
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
    const origin = activePieceSquare();
    if (!origin) return;
    const step = getCaptureSteps(board, origin.row, origin.col).find(
      (candidate) => candidate.toRow === toRow && candidate.toCol === toCol
    );
    if (!step) return;

    const piece = board[origin.row][origin.col];
    board[origin.row][origin.col] = null;
    board[step.captureRow][step.captureCol] = null;
    board[toRow][toCol] = piece;
    chainPath.push({ row: toRow, col: toCol });
    lastMove = {
      path: [{ row: selectedPiece.row, col: selectedPiece.col }, ...chainPath],
      capture: true,
    };

    activeChainSet = activeChainSet.filter((entry) => {
      const expected = entry.chain.path[chainPath.length - 1];
      return Boolean(expected) && expected.row === toRow && expected.col === toCol;
    });

    // Promotion ends the turn even if the piece could capture again.
    if (!isDama(piece) && toRow === promotionRow(pieceColor(piece))) {
      board[toRow][toCol] = promotePiece(piece);
      finishTurn({ captured: true, promoted: true });
      return;
    }

    const canContinue = activeChainSet.some(
      (entry) => entry.chain.path.length > chainPath.length
    );
    if (canContinue) {
      legalMoves = hopsAt(activeChainSet, chainPath.length);
      refreshUI();
      return;
    }

    finishTurn({ captured: true, promoted: false });
  }

  // Applies a complete chain atomically. Used as a programmatic entry point and
  // by the UI to replay a whole maximum chain if needed.
  function executeCaptureChain(chainEntry) {
    if (!chainEntry) return false;
    const chain = chainEntry.chain ? chainEntry.chain : chainEntry;
    if (!Array.isArray(chain.path) || chain.path.length === 0) return false;
    if (typeof chainEntry.row !== "number" || typeof chainEntry.col !== "number") {
      return false;
    }

    let row = chainEntry.row;
    let col = chainEntry.col;
    for (const step of chain.path) {
      const jump = getCaptureSteps(board, row, col).find(
        (candidate) => candidate.toRow === step.row && candidate.toCol === step.col
      );
      if (!jump) return false;
      const piece = board[row][col];
      board[row][col] = null;
      board[jump.captureRow][jump.captureCol] = null;
      board[step.row][step.col] = piece;
      row = step.row;
      col = step.col;
    }

    let promoted = false;
    const landingPiece = board[row][col];
    if (landingPiece && !isDama(landingPiece) && row === promotionRow(pieceColor(landingPiece))) {
      board[row][col] = promotePiece(landingPiece);
      promoted = true;
    }

    lastMove = {
      path: [{ row: chainEntry.row, col: chainEntry.col }, ...chain.path],
      capture: true,
    };
    finishTurn({ captured: true, promoted });
    return true;
  }

  function finishTurn({ captured, promoted }) {
    clearSelection();
    if (captured || promoted) {
      movesWithoutCaptureOrPromotion = 0;
    } else {
      movesWithoutCaptureOrPromotion += 1;
    }
    switchTurn();
    if (!checkGameEnd()) startTurn();
    refreshUI();
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
        title: COLOR_NAMES[rival] + " Wins!",
        detail: COLOR_NAMES[player] + " has no pieces left on the board.",
      };
    }
    if (!hasAnyLegalMove(player)) {
      return {
        title: COLOR_NAMES[rival] + " Wins!",
        detail: COLOR_NAMES[player] + " has pieces but no legal move.",
      };
    }
    if (movesWithoutCaptureOrPromotion >= DRAW_PLY_LIMIT) {
      return {
        title: "Draw",
        detail: "100 moves each without a capture or a promotion.",
      };
    }
    return null;
  }

  function checkGameEnd() {
    if (gameOver) return true;
    const result = evaluateGameState(currentPlayer);
    if (!result) return false;
    endGame(result.title, result.detail);
    return true;
  }

  function endGame(title, detail) {
    gameOver = true;
    dom.endTitle.textContent = title;
    dom.endDetail.textContent = detail;
    dom.endCard.classList.remove("winner-red", "winner-blue", "winner-draw");
    if (title === "Draw") {
      dom.endCard.classList.add("winner-draw");
    } else if (title.indexOf("Red") === 0) {
      dom.endCard.classList.add("winner-red");
    } else {
      dom.endCard.classList.add("winner-blue");
    }
    showScreen("screen-end");
  }

  /* ------------------------------------------------------------------ */
  /* Interaction                                                        */
  /* ------------------------------------------------------------------ */

  function handleSquareClick(row, col) {
    if (gameOver) return;

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
    if (chainPath.length > 0) return;

    if (selectedPiece) {
      if (selectedPiece.row === row && selectedPiece.col === col) {
        clearSelection();
        refreshUI();
        return;
      }
      if (isOwnPiece(row, col, currentPlayer)) {
        if (selectPiece(row, col)) refreshUI();
        return;
      }
      return;
    }

    if (selectPiece(row, col)) refreshUI();
  }

  function handleBoardKeydown(event) {
    const deltas = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };

    if (event.key === "Home") {
      event.preventDefault();
      focusBoardSquare(0, 0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusBoardSquare(BOARD_SIZE - 1, BOARD_SIZE - 1);
      return;
    }

    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const row = Math.min(BOARD_SIZE - 1, Math.max(0, focusedSquare.row + delta[0]));
    const col = Math.min(BOARD_SIZE - 1, Math.max(0, focusedSquare.col + delta[1]));
    focusBoardSquare(row, col);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function createPieceElement(piece) {
    const element = document.createElement("span");
    element.className =
      "piece " + (pieceColor(piece) === "R" ? "piece--red" : "piece--blue");

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
    const file = String.fromCharCode(97 + col);
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
        const isMandatory = mandatoryKeys.has(key) && !gameOver && !isSelected;

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

  function updateStatus() {
    dom.turnDot.classList.toggle("is-blue", currentPlayer === "B");
    dom.turnText.textContent = gameOver
      ? "Game over"
      : "Turn: " + COLOR_NAMES[currentPlayer];
    dom.playerRed.classList.toggle("is-active", !gameOver && currentPlayer === "R");
    dom.playerBlue.classList.toggle("is-active", !gameOver && currentPlayer === "B");

    if (gameOver) {
      dom.statusText.textContent = dom.endTitle.textContent;
      return;
    }
    if (chainPath.length > 0) {
      dom.statusText.textContent =
        COLOR_NAMES[currentPlayer] + " must continue the capture chain.";
      return;
    }
    if (turnBestChains.length > 0) {
      dom.statusText.textContent =
        COLOR_NAMES[currentPlayer] +
        " must capture — only the longest capture chain is allowed.";
      return;
    }
    dom.statusText.textContent = COLOR_NAMES[currentPlayer] + " to move.";
  }

  function refreshUI() {
    renderBoard();
    updateStatus();
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
    const square = squareEls[row][col];
    if (square) square.focus({ preventScroll: true });
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

  function resetGameState() {
    board = createInitialBoard();
    currentPlayer = "R";
    movesWithoutCaptureOrPromotion = 0;
    gameOver = false;
    lastMove = null;
    clearSelection();
    turnBestChains = [];
    mandatoryCapturePieces = [];
    focusedSquare = { ...START_FOCUS };
    startTurn();
    refreshUI();
  }

  function restartGame() {
    resetGameState();
    dom.endCard.classList.remove("winner-red", "winner-blue", "winner-draw");
    showScreen("screen-game");
    focusBoardSquare(START_FOCUS.row, START_FOCUS.col);
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

  function cacheDom() {
    dom.screens = Array.from(document.querySelectorAll(".screen"));
    dom.board = document.getElementById("board");
    dom.statusText = document.getElementById("status-text");
    dom.turnText = document.getElementById("turn-text");
    dom.turnDot = document.getElementById("turn-dot");
    dom.playerRed = document.getElementById("player-red");
    dom.playerBlue = document.getElementById("player-blue");
    dom.redRemaining = document.getElementById("red-remaining");
    dom.blueRemaining = document.getElementById("blue-remaining");
    dom.redCaptured = document.getElementById("red-captured");
    dom.blueCaptured = document.getElementById("blue-captured");
    dom.endTitle = document.getElementById("end-title");
    dom.endDetail = document.getElementById("end-detail");
    dom.endCard = document.getElementById("end-card");
  }

  function bindControls() {
    document.getElementById("btn-start").addEventListener("click", restartGame);
    document.getElementById("btn-howto").addEventListener("click", () => {
      showScreen("screen-howto");
    });
    document.getElementById("btn-howto-back").addEventListener("click", () => {
      showScreen("screen-title");
    });
    document.getElementById("btn-restart").addEventListener("click", restartGame);
    document.getElementById("btn-menu").addEventListener("click", () => {
      showScreen("screen-title");
    });
    document.getElementById("btn-again").addEventListener("click", restartGame);
    document.getElementById("btn-end-menu").addEventListener("click", () => {
      showScreen("screen-title");
    });
  }

  function init() {
    cacheDom();
    buildBoard();
    bindControls();
    resetGameState();
    showScreen("screen-title");
  }

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
      setState(nextBoard, player, quietPlies = 0) {
        board = nextBoard;
        currentPlayer = player;
        movesWithoutCaptureOrPromotion = quietPlies;
        gameOver = false;
      },
      getBoard: () => board,
      getCurrentPlayer: () => currentPlayer,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
