# Warhorn — Border Line

A real-time **online multiplayer** territory-war Go variant, built as a monorepo web app
(engine · server · web client). This repository is the **web edition** of the
Border Line (战争号角-边境线) ruleset v9.0.

Two players deploy on their own half of a 19×19 board, establish strongholds in the
opening, then score by encircling, sieging and capturing in the opponent's zone —
while replenishing troops by capturing/sieging on your own side.

## Rules (v9.0) at a glance

- 19×19 board. Row 10 (0-based row 9) is the **border line** dividing Black's territory
  (rows 0–8) from White's (rows 10–18).
- **Opening / deploy phase**: the first 4 moves (2 per side) must be played in your own
  territory and become automatic **strongholds**.
- **Scoring** (all only in the attack zone = opponent's territory ∪ border line):
  - enclosed area `+2 / point`
  - sieged stones `+3 / stone`
  - captures `+4 / stone`
  - stronghold taken `+10 / once`
  - your own casualties `−1 / stone`
- Sieging/capturing on your own side **replenishes troops**.
- Komi `+5` to White. Each side starts with **90 pieces**.
- **Timer**: 10 min main time + 5×60s byo-yomi.
- Optional **war fog**: until move 30, the board is only partially visible.
- Sudden-death endgame: if the trailing player runs out of pieces while the leader still
  has reserves, the game ends immediately.

## Tech stack

- **Monorepo** managed with npm workspaces
- `packages/engine` — pure TypeScript rules engine (GoRules, GameSession, scorers, AI)
- `packages/server` — Node + Express + Socket.io (lobby, match queue, game rooms,
  reconnect & reconnect-window, leaderboard, stats, auth, store)
- `packages/client` — Vite + TypeScript web client (custom board canvas, score panel,
  game log, replay, online & life/death screens)
- `packages/shared` — shared types/constants between packages

## Getting started

Requires **Node.js ≥ 18**.

```bash
npm install
```

Run everything (script opens both server and client windows):

```bash
start.bat            # Windows convenience launcher
```

Or run each workspace individually:

```bash
npm run dev:server   # API + Socket.io on http://localhost:3000
npm run dev:client   # web client on  http://localhost:5173
```

Open the client URL in your browser to play.

### Build for production

```bash
npm run build        # typechecks + builds server & client
```

## Workspace scripts

| Script | What it does |
|--------|--------------|
| `npm run dev:server` | start the server in watch mode |
| `npm run dev:client` | start the Vite dev client |
| `npm run build` | typecheck & build server + client |
| `npm run typecheck` | typecheck all workspaces |
| `npm run test:engine` | run the engine unit tests (Node test runner) |

## Repository layout

```
web/
├─ package.json              # workspace root
├─ packages/
│  ├─ engine/                # rules engine (pure TS)
│  ├─ server/                # Express + Socket.io backend
│  ├─ client/                # Vite web client
│  └─ shared/                # shared types & constants
├─ scripts/                  # helper scripts
├─ nixpacks.toml / railway.json
└─ start.bat                 # Windows launcher
```

## Notes

- User-facing text is English/German ready; translation table lives in `client/src/i18n.ts`.
- A future **"Dawn of the Final Battle"** expansion (with a skill system) is planned.