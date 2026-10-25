(function (root) {
  "use strict";

  const SIZE = 8;
  const MATCH_GAME_LIMITS = Object.freeze({
    single: 1,
    bestOfThree: 3,
    bestOfFive: 5,
    bestOfNine: 9,
  });
  const DIRECTIONS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const PIECES = [null, "R", "B", "RD", "BD"];
  const inside = (row, col) => Number.isInteger(row) && Number.isInteger(col) &&
    row >= 0 && row < SIZE && col >= 0 && col < SIZE;
  const playable = (row, col) => inside(row, col) && (row + col) % 2 === 1;
  const colorOf = (piece) => piece ? piece[0] : null;
  const dama = (piece) => piece === "RD" || piece === "BD";
  const opposite = (color) => color === "R" ? "B" : "R";
  const promotionRow = (color) => color === "R" ? 0 : 7;
  const copy = (board) => board.map((line) => line.slice());
  const sameSquare = (a, b) => a && b && a.row === b.row && a.col === b.col;
  const samePath = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((step, index) => sameSquare(step, b[index]));

  function initialBoard() {
    const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    for (let row = 0; row < SIZE; row++) {
      if (row > 2 && row < 5) continue;
      for (let col = 0; col < SIZE; col++) {
        if (playable(row, col)) board[row][col] = row < 3 ? "B" : "R";
      }
    }
    return board;
  }

  function validBoard(board) {
    return Array.isArray(board) && board.length === SIZE && board.every((line, row) =>
      Array.isArray(line) && line.length === SIZE && line.every((piece, col) =>
        PIECES.includes(piece) && (!piece || playable(row, col))));
  }

  function normalSteps(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];
    const steps = [];
    if (dama(piece)) {
      for (const [dr, dc] of DIRECTIONS) {
        let r = row + dr;
        let c = col + dc;
        while (inside(r, c) && board[r][c] === null) {
          steps.push({ row: r, col: c });
          r += dr;
          c += dc;
        }
      }
    } else {
      const dr = colorOf(piece) === "R" ? -1 : 1;
      for (const dc of [-1, 1]) {
        const r = row + dr;
        const c = col + dc;
        if (inside(r, c) && board[r][c] === null) steps.push({ row: r, col: c });
      }
    }
    return steps;
  }

  function captureSteps(board, row, col) {
    const piece = board[row][col];
    if (!piece) return [];
    const steps = [];
    for (const [dr, dc] of DIRECTIONS) {
      let r = row + dr;
      let c = col + dc;
      if (dama(piece)) {
        while (inside(r, c) && board[r][c] === null) {
          r += dr;
          c += dc;
        }
      }
      if (!inside(r, c) || !board[r][c] || colorOf(board[r][c]) === colorOf(piece)) {
        continue;
      }
      const landingRow = r + dr;
      const landingCol = c + dc;
      if (inside(landingRow, landingCol) && board[landingRow][landingCol] === null) {
        steps.push({
          to: { row: landingRow, col: landingCol },
          captured: { row: r, col: c },
        });
      }
    }
    return steps;
  }

  function captureChains(board, row, col) {
    const piece = board[row][col];
    const chains = [];
    function visit(position, source, path, captures, visited) {
      let continued = false;
      for (const step of captureSteps(source, position.row, position.col)) {
        const key = step.to.row + "," + step.to.col;
        if (visited.has(key)) continue;
        continued = true;
        const next = copy(source);
        next[position.row][position.col] = null;
        next[step.captured.row][step.captured.col] = null;
        next[step.to.row][step.to.col] = piece;
        const nextVisited = new Set(visited);
        nextVisited.add(key);
        visit(step.to, next, path.concat([step.to]),
          captures.concat([step.captured]), nextVisited);
      }
      if (!continued && captures.length) {
        const destination = path[path.length - 1];
        chains.push({ path, captures,
          promoted: !dama(piece) && destination.row === promotionRow(colorOf(piece)) });
      }
    }
    visit({ row, col }, board, [], [], new Set([row + "," + col]));
    return chains;
  }

  function legalMoves(board, color) {
    if (!validBoard(board) || (color !== "R" && color !== "B")) return [];
    let longest = 0;
    let captures = [];
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const piece = board[row][col];
        if (colorOf(piece) !== color) continue;
        for (const chain of captureChains(board, row, col)) {
          if (chain.captures.length > longest) {
            longest = chain.captures.length;
            captures = [];
          }
          if (chain.captures.length === longest) {
            captures.push({ from: { row, col }, path: chain.path,
              captures: chain.captures, promoted: chain.promoted });
          }
        }
      }
    }
    if (longest) return captures;
    const moves = [];
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        const piece = board[row][col];
        if (colorOf(piece) !== color) continue;
        for (const destination of normalSteps(board, row, col)) {
          moves.push({ from: { row, col }, path: [destination], captures: [],
            promoted: !dama(piece) && destination.row === promotionRow(color) });
        }
      }
    }
    return moves;
  }

  function applyMove(board, color, quietPlies, proposal) {
    if (!validBoard(board) || (color !== "R" && color !== "B") ||
        !Number.isInteger(quietPlies) || quietPlies < 0 || quietPlies >= 200 ||
        !proposal || !playable(proposal.from?.row, proposal.from?.col) ||
        !Array.isArray(proposal.path) || !Array.isArray(proposal.captures) ||
        typeof proposal.promoted !== "boolean") {
      throw new Error("Invalid move");
    }
    const move = legalMoves(board, color).find((candidate) =>
      sameSquare(candidate.from, proposal.from) &&
      samePath(candidate.path, proposal.path) &&
      samePath(candidate.captures, proposal.captures) &&
      candidate.promoted === proposal.promoted);
    if (!move) throw new Error("Invalid move");
    const piece = board[move.from.row][move.from.col];
    const next = copy(board);
    next[move.from.row][move.from.col] = null;
    for (const captured of move.captures) next[captured.row][captured.col] = null;
    const destination = move.path[move.path.length - 1];
    next[destination.row][destination.col] = move.promoted ? piece + "D" : piece;
    const nextTurn = opposite(color);
    const quiet = move.captures.length || move.promoted ? 0 : quietPlies + 1;
    const remaining = next.flat().filter((entry) => colorOf(entry) === nextTurn).length;
    let result = null;
    if (!remaining) result = { winner: color, reason: "no-pieces" };
    else if (!legalMoves(next, nextTurn).length) {
      result = { winner: color, reason: "no-moves" };
    } else if (quiet >= 200) result = { winner: null, reason: "quiet-limit" };
    return { board: next, nextTurn, quietPlies: quiet, result, move: {
      from: move.from,
      to: destination,
      path: move.path,
      captures: move.captures,
      promoted: move.promoted,
      pieceType: dama(piece) ? "dama" : "normal",
      playerColor: color,
    } };
  }

  const api = Object.freeze({ initialBoard, validBoard, legalMoves, applyMove,
    MATCH_GAME_LIMITS });
  root.DamaOnlineRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
