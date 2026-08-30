// 对局回放屏：从服务器拉取最近对局棋谱，按封存规则重建并逐手回放
// 支持：上一步 / 下一步 / 自动播放 / 拖动进度。展示最近对局公开数据。

import { GameSession, Color, PIECE_LIMIT } from "@warhorn/engine";
import type { MoveRecord, ScoreBreakdown } from "@warhorn/shared";
import { BoardCanvas } from "../BoardCanvas.js";
import { t, tpl } from "../i18n.js";

// 与后端 Store.GameRecord 对应的对局记录（仅用回放所需字段）
export interface ReplayGame {
  id: string;
  black: string;
  white: string;
  winner: string;
  winnerColor: Color;
  reason: string;
  ply: number;
  finalBlack: number;
  finalWhite: number;
  endedAt: number;
  komi: number;
  pieceLimit: number;
  moves: MoveRecord[];
  fogEnabled: boolean;
  specialForces: boolean;
  breakdownBlack: ScoreBreakdown;
  breakdownWhite: ScoreBreakdown;
}

interface ReplaySnapshot {
  grid: Uint8Array;
  lastMove: { row: number; col: number } | null;
  toMove: Color;
  scoreBlack: number;
  scoreWhite: number;
}

const AUTOPLAY_MS = 600;

// 实时总分（不含贴目/终局特种奖励），与对局内判定口径一致
function calcTotal(b: ScoreBreakdown): number {
  return (
    b.occupationTerritory +
    b.occupationEfficiency +
    b.defenseAnnihilate +
    b.defenseSiege +
    b.casualtyLoss +
    b.casualtySpecial
  );
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

export class ReplayScreen {
  readonly el: HTMLElement;
  private game: ReplayGame | null = null;
  private snapshots: ReplaySnapshot[] = [];
  private boardCanvas: BoardCanvas;
  private index = 0;
  private playing = false;
  private playTimer: number | null = null;
  private readonly onBack: () => void;

  private titleEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private moveEl!: HTMLElement;
  private sliderEl!: HTMLInputElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private playBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  constructor(gameId: string, onBack: () => void) {
    this.onBack = onBack;
    this.boardCanvas = new BoardCanvas({ cellSize: 30, padding: 26 });
    this.el = this._build();
    this._load(gameId);
  }

  destroy(): void {
    this._stopPlay();
    this.boardCanvas.destroy();
  }

  private _build(): HTMLElement {
    const root = document.createElement("div");
    root.className = "screen game-screen replay-screen";
    root.innerHTML = `
      <div class="game-main">
        <div class="game-topbar">
          <span class="topbar-title" id="rp-title">${t("replay.title")}</span>
          <span class="topbar-status" id="rp-status">${t("replay.loading")}</span>
        </div>
        <div class="board-wrapper">
          <div class="board-container" id="rp-board"></div>
        </div>
        <div class="game-controls replay-controls">
          <button class="btn" id="rp-prev" title="${t("replay.prev")}">${t("replay.prev")}</button>
          <button class="btn" id="rp-play">${t("replay.play")}</button>
          <button class="btn" id="rp-next" title="${t("replay.next")}">${t("replay.next")}</button>
          <span class="replay-move-label" id="rp-move"></span>
          <input id="rp-slider" type="range" min="0" max="0" value="0" step="1" />
          <button class="btn" id="rp-end">${t("replay.end")}</button>
          <span class="replay-meta" id="rp-meta"></span>
        </div>
      </div>
    `;
    root.querySelector("#rp-board")!.appendChild(this.boardCanvas.canvas);

    this.titleEl = root.querySelector("#rp-title")!;
    this.statusEl = root.querySelector("#rp-status")!;
    this.metaEl = root.querySelector("#rp-meta")!;
    this.moveEl = root.querySelector("#rp-move")!;
    this.sliderEl = root.querySelector("#rp-slider") as HTMLInputElement;
    this.prevBtn = root.querySelector("#rp-prev")!;
    this.nextBtn = root.querySelector("#rp-next")!;
    this.playBtn = root.querySelector("#rp-play")!;
    const endBtn = root.querySelector("#rp-end")!;

    this.prevBtn.addEventListener("click", () => this._step(-1));
    this.nextBtn.addEventListener("click", () => this._step(1));
    endBtn.addEventListener("click", () => this._jump(this.snapshots.length - 1));
    this.playBtn.addEventListener("click", () => this._togglePlay());
    this.sliderEl.addEventListener("input", () => this._jump(Number(this.sliderEl.value)));

    // 返回大厅
    const backBtn = document.createElement("button");
    backBtn.className = "btn";
    backBtn.textContent = t("replay.gotoBack");
    backBtn.addEventListener("click", () => {
      this._stopPlay();
      this.onBack();
    });
    root.querySelector(".replay-controls")!.appendChild(backBtn);

    return root;
  }

  private async _load(gameId: string): Promise<void> {
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(gameId)}`);
      if (!res.ok) {
        this.statusEl.textContent = res.status === 404 ? t("replay.notFound") : t("replay.serverError");
        return;
      }
      const data = await res.json();
      this.game = data.game as ReplayGame;
      this._buildSnapshots();
      this._render();
    } catch (err) {
      console.warn("[replay] 回放加载失败", err);
      this.statusEl.textContent = t("replay.loadFail");
    }
  }

  // 按封存棋谱逐步重建局面（引擎确定性，逐手应用即可还原）
  // 防御性跳过非法手，保证已存对局总能展示到最后一个多数派可重走节点
  private _buildSnapshots(): void {
    const g = this.game!;
    const snapshots: ReplaySnapshot[] = [];
    const session = new GameSession({
      komi: g.komi,
      pieceLimit: g.pieceLimit || PIECE_LIMIT,
      enableDeployPhase: true,
      fogEnabled: g.fogEnabled === true,
      specialForces: g.specialForces === true,
    });
    // 初始快照（空盘）
    snapshots.push(this._snap(session, null));
    for (const m of g.moves || []) {
      const color = m.c === Color.WHITE ? Color.WHITE : Color.BLACK;
      let outcome;
      if (m.k === "v") {
        outcome = session.doPass(color);
      } else if (m.k === "s") {
        outcome = session.deploySpecial(color, m.r, m.col);
      } else {
        outcome = session.playMove(color, m.r, m.col);
      }
      if (!outcome || !outcome.ok) {
        // 非法/不可重走手：停止（多数情况下为最后一手后的特殊终局卡点）
        console.warn("[replay] 第", snapshots.length, "手无法重走，停止推进", m, outcome?.reason);
        break;
      }
      snapshots.push(this._snap(session, outcome.placed ?? null));
    }
    this.snapshots = snapshots;
    this.sliderEl.max = String(snapshots.length - 1);
  }

  private _snap(session: GameSession, placed: { row: number; col: number } | null): ReplaySnapshot {
    const scores = session.scores();
    return {
      grid: session.board.grid.slice(),
      lastMove: placed && placed.row >= 0 ? { row: placed.row, col: placed.col } : null,
      toMove: session.toMove,
      scoreBlack: calcTotal(scores.black),
      scoreWhite: calcTotal(scores.white),
    };
  }

  private _render(): void {
    const g = this.game!;
    const s = this.snapshots[this.index];
    // 公开回放展示全盘可见（含特殊隐子），不按迷雾隐藏
    this.boardCanvas.updateState(
      s.grid,
      s.lastMove,
      [],
      [],
      s.toMove,
      undefined,
      false,
      undefined,
      s.scoreBlack,
      s.scoreWhite
    );

    const total = this.snapshots.length;
    const isEnd = this.index >= total - 1;
    this.statusEl.textContent = isEnd
      ? tpl("replay.final", escapeHtml(this._winnerText()))
      : tpl("replay.move", this.index);
    this.moveEl.textContent = `${this.index} / ${total - 1}`;
    this.sliderEl.value = String(this.index);
    this.prevBtn.disabled = this.index <= 0;
    this.nextBtn.disabled = isEnd;
    this.playBtn.textContent = t(this.playing ? "replay.pause" : "replay.play");
    this.playBtn.disabled = isEnd && !this.playing;
    this.titleEl.textContent = `${t("replay.title")} · ${escapeHtml(g.black)} vs ${escapeHtml(g.white)}`;
    this.metaEl.textContent = `黑 ${s.scoreBlack} : 白 ${s.scoreWhite}`;
  }

  private _winnerText(): string {
    const g = this.game!;
    if (!g || g.winnerColor === undefined) return t("replay.end");
    const name = g.winnerColor === Color.BLACK ? g.black : g.white;
    return tpl("win", escapeHtml(name || (g.winnerColor === Color.BLACK ? t("black") : t("white"))));
  }

  private _step(delta: number): void {
    const target = this.index + delta;
    this._jump(Math.max(0, Math.min(this.snapshots.length - 1, target)));
  }

  private _jump(idx: number): void {
    this.index = Math.max(0, Math.min(this.snapshots.length - 1, idx));
    this._render();
  }

  private _togglePlay(): void {
    // 到终局后再按播放则回到开始重新播放
    if (this.playing) {
      this._stopPlay();
      this._render();
      return;
    }
    if (this.index >= this.snapshots.length - 1) {
      this._stopPlay();
      this._jump(0);
    }
    this.playing = true;
    this.playBtn.textContent = t("replay.pause");
    this.playTimer = window.setInterval(() => {
      if (this.index >= this.snapshots.length - 1) {
        this._stopPlay();
        return;
      }
      this._step(1);
    }, AUTOPLAY_MS);
  }

  private _stopPlay(): void {
    this.playing = false;
    if (this.playTimer !== null) {
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }
}