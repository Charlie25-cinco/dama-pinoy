// Dama Pinoy v2.2. Deploy with JWT verification enabled. Never bundle this
// function or its service-role environment variable into the frontend.
import "../../../online-rules.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const rules = globalThis.DamaOnlineRules;
const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Content-Type": "application/json; charset=utf-8",
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function roomCode() {
  const random = new Uint32Array(6);
  crypto.getRandomValues(random);
  return Array.from(random, (number) => alphabet[number % alphabet.length]).join("");
}

function guestName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 20 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("Enter a guest name of up to 20 characters.");
  }
  return name;
}

function requireRoomId(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new Error("Invalid room.");
  }
  return value;
}

function roomOptions(body) {
  const color = body.color === undefined ? "R" : body.color;
  const format = body.format === undefined ? "single" : body.format;
  if ((color !== "R" && color !== "B") ||
      typeof format !== "string" || !Object.prototype.hasOwnProperty.call(rules.MATCH_GAME_LIMITS, format)) {
    throw new Error("Invalid room options.");
  }
  return { color, format };
}

async function snapshot(db, roomId, userId, attempt = 0) {
  const { data: room, error } = await db.from("rooms").select("*").eq("id", roomId).single();
  if (error || !room) {
    throw new Error("Room unavailable.");
  }
  const spectators = await db.from("room_spectators").select("guest_id,guest_name,last_seen_at")
    .eq("room_id", roomId).gt("last_seen_at", new Date(Date.now() - 60000).toISOString());
  if (spectators.error) throw new Error("Room unavailable.");
  const isPlayer = room.host_user_id === userId || room.guest_user_id === userId;
  if (!isPlayer && !(spectators.data || []).some((s) => s.guest_id === userId)) {
    throw new Error("Room unavailable.");
  }
  let game = null;
  let moves = [];
  if (room.guest_user_id) {
    const loaded = await db.from("games").select("*")
      .eq("room_id", room.id)
      .eq("series_number", room.current_series_number)
      .eq("game_number", room.current_game_number).single();
    if (loaded.error || !loaded.data) throw new Error("Room unavailable.");
    game = loaded.data;
    const history = await db.from("moves").select("*")
      .eq("game_id", game.id).order("move_number", { ascending: true });
    if (history.error) throw new Error("Room unavailable.");
    moves = history.data || [];
  }
  // A move/rematch may commit between these reads. Only return a snapshot
  // whose room version stayed stable throughout the game/history fetch.
  const latest = await db.from("rooms").select("version").eq("id", roomId).single();
  if (latest.error) throw new Error("Room unavailable.");
  if (latest.data.version !== room.version || (game && moves.length !== game.move_count)) {
    if (attempt >= 2) throw new Error("Room unavailable or state changed. Please retry.");
    return snapshot(db, roomId, userId, attempt + 1);
  }
  return {
    role: isPlayer ? "player" : "spectator",
    spectators: (spectators.data || []).map((s) => ({ id: s.guest_id, name: s.guest_name })),
    room: {
      id: room.id, code: room.room_code, status: room.status,
      hostId: room.host_user_id, guestId: room.guest_user_id,
      hostName: room.host_name, guestName: room.guest_name,
      hostColor: room.host_color, guestColor: room.guest_color,
      turn: room.current_turn, version: room.version,
      seriesFormat: room.series_format,
      seriesNumber: room.current_series_number,
      gameNumber: room.current_game_number,
      hostScore: room.host_score, guestScore: room.guest_score,
      draws: room.draws, matchWinnerId: room.match_winner_user_id,
      rematchHost: room.rematch_host, rematchGuest: room.rematch_guest,
      hostSeenAt: room.host_seen_at, guestSeenAt: room.guest_seen_at,
    },
    game: game && {
      id: game.id, board: game.board, status: game.status,
      seriesNumber: game.series_number, gameNumber: game.game_number,
      hostColor: game.host_color, guestColor: game.guest_color,
      quietPlies: game.quiet_plies, moveCount: game.move_count,
      winner: game.winner_color, reason: game.result_reason,
    },
    moves: moves.map((move) => ({
      number: move.move_number, playerColor: move.player_color,
      from: { row: move.from_row, col: move.from_col },
      to: { row: move.to_row, col: move.to_col },
      path: move.path, captures: move.captured_squares,
      pieceType: move.piece_type, promoted: move.promoted,
    })),
  };
}

async function rpc(db, name, parameters) {
  const { data, error } = await db.rpc(name, parameters);
  if (error) throw new Error("Room unavailable or state changed. Please retry.");
  return data;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !publicKey || !serviceKey) {
    return reply({ error: "Online service unavailable." }, 503);
  }

  try {
    const text = await request.text();
    if (text.length > 12000) return reply({ error: "Request too large." }, 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply({ error: "Invalid request." }, 400);
    }
    const auth = createClient(url, publicKey, { auth: { persistSession: false } });
    const verified = await auth.auth.getUser(token);
    const user = verified.data?.user;
    if (verified.error || !user || user.is_anonymous !== true) {
      return reply({ error: "Guest session unavailable. Reopen Online Multiplayer." }, 401);
    }
    const db = createClient(url, serviceKey, { auth: { persistSession: false } });
    const userId = user.id;
    let id;

    switch (body.action) {
      case "create": {
        const name = guestName(body.name);
        const options = roomOptions(body);
        const recent = await db.from("rooms").select("id", { count: "exact", head: true })
          .eq("host_user_id", userId)
          .gte("created_at", new Date(Date.now() - 3600000).toISOString());
        if (recent.error || (recent.count || 0) >= 5) {
          return reply({ error: "Too many rooms created. Try again later." }, 429);
        }
        for (let attempt = 0; attempt < 8; attempt++) {
          const code = roomCode();
          const created = await db.rpc("online_create_room", {
            p_code: code, p_name: name, p_user: userId,
            p_color: options.color, p_format: options.format,
          });
          if (!created.error) return reply({ state: await snapshot(db, created.data, userId) });
          if (created.error.code !== "23505") {
            throw new Error("Could not create a room.");
          }
        }
        throw new Error("Could not create a room. Try again.");
      }
      case "spectate":
      case "join": {
        const name = guestName(body.name);
        const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
        if (!new RegExp("^[" + alphabet + "]{6}$").test(code)) {
          throw new Error("Enter a valid six-character room code.");
        }
        id = await rpc(db, body.action === "spectate" ? "online_join_spectator" : "online_join_room", {
          p_code: code, p_name: name, p_user: userId,
          ...(body.action === "join" ? { p_board: rules.initialBoard() } : {}),
        });
        return reply({ state: await snapshot(db, id, userId) });
      }
      case "replays": {
        // Execute reads with the caller JWT, not service-role privileges.
        const reader = createClient(url, publicKey, { auth: { persistSession: false },
          global: { headers: { Authorization: "Bearer " + token } } });
        const list = await reader.from("online_replays")
          .select("id,host_guest_id,guest_guest_id,host_name,guest_name,series_format,series_number,game_number,result,created_at")
          .or("host_guest_id.eq." + userId + ",guest_guest_id.eq." + userId)
          .order("created_at", { ascending: false }).limit(20);
        if (list.error) throw new Error("Room unavailable.");
        return reply({ replays: list.data || [] });
      }
      case "replay": {
        const reader = createClient(url, publicKey, { auth: { persistSession: false },
          global: { headers: { Authorization: "Bearer " + token } } });
        let query = reader.from("online_replays").select("*");
        query = body.replayId ? query.eq("id", requireRoomId(body.replayId))
          : query.eq("game_id", requireRoomId(body.gameId));
        const replay = await query.single();
        if (replay.error || !replay.data) throw new Error("Room unavailable.");
        return reply({ replay: replay.data });
      }
      case "state":
      case "heartbeat": {
        id = requireRoomId(body.roomId);
        await rpc(db, "online_heartbeat", { p_room: id, p_user: userId });
        return reply({ state: await snapshot(db, id, userId) });
      }
      case "move": {
        id = requireRoomId(body.roomId);
        await rpc(db, "online_heartbeat", { p_room: id, p_user: userId });
        const current = await snapshot(db, id, userId);
        const room = current.room;
        const game = current.game;
        const owner = game && (room.hostId === userId ? game.hostColor :
          room.guestId === userId ? game.guestColor : null);
        if (room.status !== "active" || !game || game.status !== "active" ||
            game.id !== body.gameId ||
            !Number.isInteger(body.moveNumber) || body.moveNumber !== game.moveCount + 1 ||
            owner !== room.turn || !rules.validBoard(game.board)) {
          return reply({ error: "Turn or room changed. Synchronizing…" }, 409);
        }
        let applied;
        try {
          applied = rules.applyMove(game.board, room.turn, game.quietPlies, body.move);
        } catch (error) {
          return reply({ error: "Invalid move." }, 400);
        }
        await rpc(db, "online_commit_move", {
          p_room: id, p_game: game.id, p_user: userId,
          p_expected_count: game.moveCount, p_move: applied.move,
          p_board: applied.board, p_quiet: applied.quietPlies,
          p_result: applied.result,
        });
        return reply({ state: await snapshot(db, id, userId) });
      }
      case "rematch": {
        id = requireRoomId(body.roomId);
        await rpc(db, "online_heartbeat", { p_room: id, p_user: userId });
        await rpc(db, "online_request_rematch", {
          p_room: id, p_user: userId, p_board: rules.initialBoard(),
        });
        return reply({ state: await snapshot(db, id, userId) });
      }
      case "leave": {
        id = requireRoomId(body.roomId);
        const current = await snapshot(db, id, userId);
        if (current.role === "spectator") {
          await rpc(db, "online_leave_spectator", { p_room: id, p_user: userId });
          return reply({ left: true });
        }
        await rpc(db, "online_leave_room", { p_room: id, p_user: userId });
        return reply({ state: await snapshot(db, id, userId) });
      }
      default:
        return reply({ error: "Invalid request." }, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Online request failed.";
    const safe = /^(Enter |Invalid |Room unavailable|Room unavailable or state changed|Could not create)/.test(message)
      ? message : "Online request failed. Try again.";
    return reply({ error: safe }, 400);
  }
});
