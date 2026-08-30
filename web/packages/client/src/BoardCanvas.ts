// Canvas 棋盘渲染：19x19 木质棋盘、网格、星位、棋子、最后一手标记、围空/围困显示
// 特效（参考原项目 BoardView.gd）：落子脉冲、提子爆裂+波浪、围困红环、围空扩散、边境线呼吸灯
// 负责绘制 + 鼠标交互（点击转 row/col）

import { BOARD_SIZE, BORDER_ROW, Color, BoardModel } from "@warhorn/engine";
import type { Enclosure, Group } from "@warhorn/engine";
import { atariStoneSet, influenceRenderData, type InfluenceRender } from "@warhorn/engine";
import { SoundFx } from "./audio/SoundFx.js";

interface BoardCanvasOptions {
  cellSize?: number;
  padding?: number;
  showCoords?: boolean;
  showTerritory?: boolean;
  showSieged?: boolean;
  borderPulse?: boolean; // 边境线呼吸灯（默认开启）
}

// 特效叠加层（参考原项目 effect_overlays）
interface EffectOverlay {
  type: EffectType;
  startTime?: number; // 秒（由 _addOverlay 赋值）
  duration: number;
  positions?: Array<{ row: number; col: number }>; // capture
  stones?: Array<{ row: number; col: number }>; // siege / siege_broken
  points?: Array<{ row: number; col: number }>; // territory_formed / territory_lost
  color?: Color;
  position?: { row: number; col: number }; // move / deploy_place
}

type EffectType =
  | "move"
  | "deploy_place"
  | "capture"
  | "siege"
  | "siege_broken"
  | "territory_formed"
  | "territory_lost"
  | "opening";

const COLS = "ABCDEFGHJKLMNOPQRST"; // 跳过 I（围棋惯例）

// 边境线统一用红色（"r, g, b" 前缀，供 rgba 拼接）
const BORDER_RGB = "222, 66, 66";

// 波光粼粼周期：每 15 秒一次，持续 3 秒
const SPARKLE_PERIOD = 15;
const SPARKLE_WINDOW = 3;

// 开局倒计时数字掩码（7 行 × 5 列，1=亮格，高位为最左列；数字均水平居中）
const COUNTDOWN_DIGITS: Record<number, number[]> = {
  1: [0b00100, 0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b11111, 0b00001, 0b00001, 0b11111, 0b10000, 0b10000, 0b11111],
  3: [0b11111, 0b00001, 0b00001, 0b00111, 0b00001, 0b00001, 0b11111],
};

// ====== 棋盘棋子主题 ======
interface BoardTheme {
  id: string;
  name: string;
  boardGrad: [string, string]; // 棋盘背景渐变（起始/结束）
  grid: string; // 网格线颜色
  star: string; // 星位颜色
  coord: string; // 坐标颜色
  border: string; // 边境线呼吸灯颜色（hex）
  borderHeight: number; // 边境线高度（格数）
  borderAlphaMin: number; // 呼吸最低 alpha
  borderAlphaMax: number; // 呼吸最高 alpha
  borderGlow: boolean; // 上下光晕渐变
  borderDashed: boolean; // 像素分段带
  territoryBlack: string; // 黑境底色（"rgba(r, g, b, " 前缀，拼接 alpha）
  territoryWhite: string; // 白境底色前缀
  blackHi: string; // 黑棋高光
  blackLo: string; // 黑棋主体
  blackEdge: string; // 黑棋描边
  whiteHi: string; // 白棋高光
  whiteLo: string; // 白棋主体
  whiteEdge: string; // 白棋描边
  openingWave: [number, number, number]; // 开局波浪主色（RGB，与棋盘底色对比）
  captureWave: [number, number, number]; // 提子波浪主色（RGB，与棋盘底色对比）
}

const THEMES: BoardTheme[] = [
  {
    id: "wood",
    name: "经典木质",
    boardGrad: ["#dcb35c", "#d2a550"],
    grid: "#3d2817",
    star: "#3d2817",
    coord: "#3d2817",
    border: "#4a9eff",
    borderHeight: 1,
    borderAlphaMin: 0.08,
    borderAlphaMax: 0.16,
    borderGlow: false,
    borderDashed: false,
    territoryBlack: "rgba(90, 140, 217, ",
    territoryWhite: "rgba(242, 199, 82, ",
    blackHi: "#4a4a4a",
    blackLo: "#1a1a1a",
    blackEdge: "#000",
    whiteHi: "#ffffff",
    whiteLo: "#d0d0d0",
    whiteEdge: "#888",
    openingWave: [40, 210, 170], // 青绿（金木底对比）
    captureWave: [255, 92, 92], // 珊瑚红
  },
  {
    id: "pixel",
    name: "动画像素风",
    boardGrad: ["#8aa9a0", "#6d8d84"],
    grid: "#ddeae7",
    star: "#e2ece9",
    coord: "#3f5f5a",
    border: "#e0b35e",
    borderHeight: 1,
    borderAlphaMin: 0.12,
    borderAlphaMax: 0.24,
    borderGlow: false,
    borderDashed: true,
    territoryBlack: "rgba(92, 148, 140, ",
    territoryWhite: "rgba(222, 184, 118, ",
    blackHi: "#8d79ba",
    blackLo: "#574687",
    blackEdge: "#3c3460",
    whiteHi: "#ffffff",
    whiteLo: "#e9eff0",
    whiteEdge: "#8fa9a4",
    openingWave: [165, 135, 255], // 亮紫（灰绿底对比）
    captureWave: [255, 143, 64], // 亮橙
  },
  {
    id: "obsidian",
    name: "黑曜石",
    boardGrad: ["#33324a", "#16151f"],
    grid: "#7c86ad",
    star: "#9aa6cc",
    coord: "#9aa6cc",
    border: "#c084fc",
    borderHeight: 1,
    borderAlphaMin: 0.16,
    borderAlphaMax: 0.32,
    borderGlow: true,
    borderDashed: false,
    territoryBlack: "rgba(120, 100, 220, ",
    territoryWhite: "rgba(150, 130, 240, ",
    blackHi: "#6d6a92",
    blackLo: "#0f0e17",
    blackEdge: "#a78bfa",
    whiteHi: "#f5f3ff",
    whiteLo: "#b8b4d6",
    whiteEdge: "#5b5b7a",
    openingWave: [92, 230, 255], // 亮青（深紫底对比）
    captureWave: [255, 172, 92], // 亮琥珀
  },
  {
    id: "porcelain",
    name: "青花瓷",
    boardGrad: ["#e9e7de", "#d7d4c9"],
    grid: "#2f5fa3",
    star: "#2f5fa3",
    coord: "#2f5fa3",
    border: "#4a9eff",
    borderHeight: 0.5,
    borderAlphaMin: 0.12,
    borderAlphaMax: 0.22,
    borderGlow: true,
    borderDashed: false,
    territoryBlack: "rgba(47, 95, 163, ",
    territoryWhite: "rgba(184, 224, 232, ", // 淡淡天青围空
    blackHi: "#1e3a5f",
    blackLo: "#0d2a4f",
    blackEdge: "#0b2b5e",
    whiteHi: "#ffffff",
    whiteLo: "#dbe7f5",
    whiteEdge: "#2f5fa3",
    openingWave: [64, 200, 122], // 翠绿（米白底对比）
    captureWave: [233, 86, 86], // 朱红（青花蓝的朱砂对照）
  },
];

// RGB 三元组提亮 → "r, g, b" 字符串（用于 rgba 拼接，模拟中心光晕）
function lightenRgb(c: [number, number, number], amt: number): string {
  return `${Math.min(255, c[0] + amt)}, ${Math.min(255, c[1] + amt)}, ${Math.min(255, c[2] + amt)}`;
}

export class BoardCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private staticCanvas: HTMLCanvasElement; // 离屏静态层缓存（背景/网格/棋子等不变元素）
  private staticCtx: CanvasRenderingContext2D;
  private staticDirty = true; // 静态层需重建标志（状态/主题变化时置位）
  private cellSize: number;
  private padding: number;
  private showCoords: boolean;
  private showTerritory: boolean;
  private showSieged: boolean;
  private borderPulse: boolean;

  // 主题风格（按 T 切换，默认青花瓷）
  private themeId = THEMES.findIndex((t) => t.id === "porcelain");
  private theme: BoardTheme = THEMES[this.themeId];

  // 当前盘面状态
  private grid: Uint8Array = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
  private lastMove: { row: number; col: number } | null = null;
  private enclosures: Enclosure[] = [];
  private siegedStones: Set<number> = new Set();
  // 特种部队标记：该视角可见的特种棋子索引（己方未现形 + 双方已现形）。
  // 渲染时叠加在对应棋子上；不包含对方未现形隐子 → 不会泄露其位置。
  private specialIdx: Set<number> = new Set();
  private hoverPos: { row: number; col: number } | null = null;
  private currentColor: Color = Color.BLACK;
  // 战争迷雾（可选规则）：fogActive 时在 fogCells 覆盖半透明浅灰迷雾
  private fogCells: Set<number> = new Set();
  private fogActive = false;
  // 双方当前总分（用于“领土染色”：每差 4 分，对方领土一格变己方色，纯视觉）
  private scoreBlack = 0;
  private scoreWhite = 0;

  // 特效叠加层
  private effectOverlays: EffectOverlay[] = [];
  private time: number = 0; // 当前秒（动画时间基）
  private animFrame: number | null = null;
  private _destroyed = false;

  // 打吃（剩最后一口气）组群标记 + 势力热力图
  private atariStones: Set<number> = new Set();
  private influence: InfluenceRender | null = null;
  private showInfluence: boolean = false;
  private sparkleEnabled: boolean = true; // 波光开关（默认开）
  private _keydownHandler: (e: KeyboardEvent) => void;
  private _themeKeyHandler: (e: KeyboardEvent) => void;

  // 布局阶段视觉提示
  private deployPhase: boolean = false;

  // 点击回调
  onCellClick?: (row: number, col: number) => void;
  // 空格切换热力图回调（用于 UI 提示）
  onInfluenceToggle?: (shown: boolean) => void;
  // 按 T 切换主题回调（用于 UI 提示当前主题名）
  onThemeToggle?: (name: string) => void;

  constructor(opts: BoardCanvasOptions = {}) {
    this.cellSize = opts.cellSize ?? 32;
    this.padding = opts.padding ?? 28;
    this.showCoords = opts.showCoords ?? true;
    this.showTerritory = opts.showTerritory ?? true;
    this.showSieged = opts.showSieged ?? true;
    this.borderPulse = opts.borderPulse ?? true;

    this.canvas = document.createElement("canvas");
    const total = this.padding * 2 + (BOARD_SIZE - 1) * this.cellSize;
    this.canvas.width = total;
    this.canvas.height = total;
    this.canvas.id = "board-canvas";

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    // 离屏静态层缓存（同尺寸；背景/网格/棋子等不变元素只画一次，动画循环仅 blit + 动态特效）
    this.staticCanvas = document.createElement("canvas");
    this.staticCanvas.width = total;
    this.staticCanvas.height = total;
    const sctx = this.staticCanvas.getContext("2d");
    if (!sctx) throw new Error("Canvas 2D context unavailable");
    this.staticCtx = sctx;

    this._keydownHandler = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      this.toggleInfluence();
    };
    window.addEventListener("keydown", this._keydownHandler);

    // 按 T 切换棋盘主题
    this._themeKeyHandler = (e: KeyboardEvent) => {
      if (e.code !== "KeyT" || e.repeat) return;
      e.preventDefault();
      this.toggleTheme();
    };
    window.addEventListener("keydown", this._themeKeyHandler);

    this._bindEvents();
    this._startAnimLoop();
    this.render();
  }

  destroy(): void {
    this._destroyed = true;
    if (this.animFrame !== null) cancelAnimationFrame(this.animFrame);
    window.removeEventListener("keydown", this._keydownHandler);
    window.removeEventListener("keydown", this._themeKeyHandler);
  }

  // 按 T 切换主题：青花瓷 → 动画像素风 → 黑曜石 → 经典木质
  toggleTheme(): void {
    this.themeId = (this.themeId + 1) % THEMES.length;
    this.theme = THEMES[this.themeId];
    this.onThemeToggle?.(this.theme.name);
    this.staticDirty = true;
    this.render();
  }

  // 空格键切换势力热力图显示
  toggleInfluence(): void {
    this.showInfluence = !this.showInfluence;
    if (this.showInfluence && !this.influence) {
      this.influence = influenceRenderData(this._board());
    }
    this.onInfluenceToggle?.(this.showInfluence);
    this.staticDirty = true;
    this.render();
  }

  // 波光开关（由下方按钮栏最右侧按钮调用）
  toggleSparkle(): boolean {
    this.sparkleEnabled = !this.sparkleEnabled;
    if (this.sparkleEnabled) this._startAnimLoop();
    this.render();
    return this.sparkleEnabled;
  }

  // 当前波光是否开启（供按钮同步文字/样式）
  isSparkleEnabled(): boolean {
    return this.sparkleEnabled;
  }

  // 从当前 grid 构造临时棋盘（状态检测用）
  private _board(): BoardModel {
    const b = new BoardModel(BOARD_SIZE);
    b.grid = this.grid;
    return b;
  }

  // 更新盘面状态
  updateState(
    grid: Uint8Array,
    lastMove: { row: number; col: number } | null,
    enclosures: Enclosure[],
    siegedGroups: Group[],
    currentColor: Color,
    fogCells?: Set<number>,
    fogActive?: boolean,
    visibleSpecials?: Set<number>,
    scoreBlack?: number,
    scoreWhite?: number
  ): void {
    this.grid = grid;
    this.lastMove = lastMove;
    this.enclosures = enclosures;
    this.scoreBlack = scoreBlack ?? 0;
    this.scoreWhite = scoreWhite ?? 0;
    this.siegedStones.clear();
    for (const g of siegedGroups) {
      for (const s of g.stones) this.siegedStones.add(s.row * BOARD_SIZE + s.col);
    }
    this.specialIdx = visibleSpecials ?? new Set();
    this.currentColor = currentColor;
    this.fogCells = fogCells ?? new Set();
    this.fogActive = fogActive ?? false;
    // 重算打吃状态与势力图（仅显示辅助）
    this.atariStones = atariStoneSet(this._board());
    this.influence = influenceRenderData(this._board());
    // 盘面变化 → 静态层需重建
    this.staticDirty = true;
    this.render();
  }

  // 鼠标悬停的预览棋子
  setHover(pos: { row: number; col: number } | null): void {
    this.hoverPos = pos;
  }

  // ====== 特效接口（参考原项目 EffectsPlayer）======

  /** 落子脉冲：金色扩散环（0.4s），黑"叮"白"咚" */
  playMove(position: { row: number; col: number }, color: Color): void {
    this._addOverlay({ type: "move", position, duration: 0.4 });
    SoundFx.playMove(color);
  }

  /** 布局落子脉冲：青绿色双层扩散环（0.5s），黑"叮"白"咚" */
  playDeployPlace(position: { row: number; col: number }, color: Color): void {
    this._addOverlay({ type: "deploy_place", position, duration: 0.5 });
    SoundFx.playMove(color);
  }

  /** 提子特效：被吃棋子呼吸加速 + 颜色渐淡至消失（0.9s） */
  playCapture(positions: Array<{ row: number; col: number }>, color: Color): void {
    this._addOverlay({ type: "capture", positions, color, duration: 0.9 });
    SoundFx.playCapture();
  }

  /** 围困形成：红色脉冲环（0.8s） */
  playSiege(stones: Array<{ row: number; col: number }>): void {
    this._addOverlay({ type: "siege", stones, duration: 0.8 });
    SoundFx.playSiege();
  }

  /** 围困解除：绿色光环扩散（0.8s） */
  playSiegeBroken(stones: Array<{ row: number; col: number }>): void {
    this._addOverlay({ type: "siege_broken", stones, duration: 0.8 });
  }

  /** 围空形成：圈内光晕扩散 + 中心环（1.0s） */
  playTerritoryFormed(points: Array<{ row: number; col: number }>, color: Color): void {
    this._addOverlay({ type: "territory_formed", points, color, duration: 1.0 });
    SoundFx.playTerritory();
  }

  /** 围空失守：灰色消散 + 边界红闪（1.0s） */
  playTerritoryLost(points: Array<{ row: number; col: number }>, color: Color): void {
    this._addOverlay({ type: "territory_lost", points, color, duration: 1.0 });
  }

  /** 开局过渡动画：从中央边境线向双方最后一行扩散的青蓝波浪（2.4s） */
  playOpeningAnimation(): void {
    this._addOverlay({ type: "opening", duration: 2.4 });
  }

  /** 开局过渡动画是否仍在进行（期间禁止下子） */
  isOpeningActive(): boolean {
    return this.effectOverlays.some((o) => o.type === "opening");
  }

  /** 设置布局阶段状态（控制领土辉光提示） */
  setDeployPhase(active: boolean): void {
    this.deployPhase = active;
    if (active) this._startAnimLoop(); // 领土辉光需要呼吸动画
  }

  private _addOverlay(ov: EffectOverlay): void {
    ov.startTime = this.time;
    this.effectOverlays.push(ov);
    this._startAnimLoop();
  }

  // 像素坐标 → 棋盘坐标 (row, col)，无效返回 null
  pixelToBoard(x: number, y: number): { row: number; col: number } | null {
    const col = Math.round((x - this.padding) / this.cellSize);
    const row = Math.round((y - this.padding) / this.cellSize);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    // 容差检查：离最近交叉点不超过 cellSize/2
    const cx = this.padding + col * this.cellSize;
    const cy = this.padding + row * this.cellSize;
    if (Math.abs(x - cx) > this.cellSize / 2 || Math.abs(y - cy) > this.cellSize / 2) return null;
    return { row, col };
  }

  // ====== 渲染 ======

  render(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;

    // 特效过期清理：独立于绘制标记执行，确保迷雾下（特效不绘制）opening 等也能按期过期，
    // 避免 isOpeningActive() 恒真导致布局完成后无法落子
    this._pruneEffectOverlays(this.time);

    // 静态层（背景/领土底色/网格/星位/坐标/热力图/围空圈/棋子/围困标记）：
    // 仅当盘面状态或主题变化（staticDirty）时重建，动画循环通过 blit 复用，避免每帧全量重绘
    if (this.staticDirty) {
      this._renderStatic();
      this.staticDirty = false;
    }
    ctx.drawImage(this.staticCanvas, 0, 0);

    // 布局阶段：领土辉光呼吸（叠加在静态领土底色之上）
    if (this.deployPhase) {
      const th = this.theme;
      const topH = cs * 9;
      const botY = pad + cs * 9;
      const glow = 0.04 + 0.03 * (0.5 + 0.5 * Math.sin(this.time * 2.5));
      ctx.fillStyle = `${th.territoryBlack}${glow.toFixed(3)})`;
      ctx.fillRect(pad, pad, cs * 18, topH);
      ctx.fillStyle = `${th.territoryWhite}${glow.toFixed(3)})`;
      ctx.fillRect(pad, botY, cs * 18, cs * 18 - topH);
    }

    // 边境线呼吸灯（随时间变化 → 动态层）
    this._drawBorderZone();

    // 最后一手标记（紫色呼吸小圆圈）
    // 迷雾下：该落点若处于迷雾区域（对方未现形隐子），不绘制标记，避免暴露其实际位置
    if (this.lastMove && this.lastMove.row >= 0 && !(this.fogActive && this.fogCells.has(this.lastMove.row * BOARD_SIZE + this.lastMove.col))) {
      const cx = pad + this.lastMove.col * cs;
      const cy = pad + this.lastMove.row * cs;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 7.85); // 0.8s 呼吸周期
      ctx.strokeStyle = `rgba(180, 100, 255, ${(0.75 + 0.2 * pulse).toFixed(3)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, cs * 0.3 * (1 + pulse * 0.1), 0, Math.PI * 2);
      ctx.stroke();
    }

    // 打吃（剩最后一口气）呼吸灯提示（迷雾下关闭：脉冲可能落到隐藏隐子区域，暴露其位置）
    if (!this.fogActive) this._drawAtariMarkers();

    // 特效叠加层（迷雾下关闭：提子/围困等脉冲动画可能标记出迷雾区隐藏位置）
    if (!this.fogActive) this._drawEffectOverlays();

    // 波光粼粼（每15秒一次，方格模拟水面波浪；可开关）
    // 迷雾下关闭：波纹会在隐藏隐子格（grid 为空）闪烁，长期观察可推断其位置
    if (this.sparkleEnabled && !this.fogActive) this._drawGlimmer();

    // 悬停预览
    if (this.hoverPos && this.grid[this.hoverPos.row * BOARD_SIZE + this.hoverPos.col] === Color.EMPTY) {
      ctx.globalAlpha = 0.4;
      this._drawStone(this.hoverPos.col, this.hoverPos.row, this.currentColor);
      ctx.globalAlpha = 1;
    }
  }

  // 静态层绘制：棋盘上不随时间变化的元素，写入离屏 canvas（staticCtx）。
  // 仅当盘面状态或主题变化（staticDirty）时重建一次
  private _renderStatic(): void {
    const ctx = this.staticCtx;
    const cs = this.cellSize;
    const pad = this.padding;
    const size = BOARD_SIZE;
    const th = this.theme;

    // 1. 棋盘背景（主题渐变）
    ctx.fillStyle = th.boardGrad[0];
    ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    const grad = ctx.createLinearGradient(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    grad.addColorStop(0, th.boardGrad[0]);
    grad.addColorStop(0.5, th.boardGrad[1]);
    grad.addColorStop(1, th.boardGrad[0]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);

    // 2. 领土方格染色（柔和区分黑白领土；棋子画在其上，不与冲突）
    const midY = pad + 9 * cs; // 边境线（第10行）中心
    // 黑方领土：冷调深蓝染色（行0-8，延伸至边境线）
    ctx.fillStyle = `${th.territoryBlack}0.16)`;
    ctx.fillRect(pad, pad, cs * 18, cs * 9);
    // 白方领土：暖调金黄染色（行10-18，延伸至边境线）
    ctx.fillStyle = `${th.territoryWhite}0.20)`;
    ctx.fillRect(pad, midY, cs * 18, cs * 9);

    // 3. 网格线 + 边框加粗
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < size; i++) {
      const y = pad + i * cs;
      ctx.moveTo(pad, y);
      ctx.lineTo(pad + (size - 1) * cs, y);
      const x = pad + i * cs;
      ctx.moveTo(x, pad);
      ctx.lineTo(x, pad + (size - 1) * cs);
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeRect(pad, pad, (size - 1) * cs, (size - 1) * cs);

    // 边境线：把第9行横网格线设为红色（前锋分界标明）
    ctx.strokeStyle = `rgba(${BORDER_RGB}, 0.55)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pad, midY);
    ctx.lineTo(pad + (size - 1) * cs, midY);
    ctx.stroke();

    // 4. 星位（9个）
    ctx.fillStyle = th.star;
    const stars = [3, 9, 15];
    for (const r of stars) {
      for (const c of stars) {
        ctx.beginPath();
        ctx.arc(pad + c * cs, pad + r * cs, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 5. 坐标标注（参考原项目：列=A-T，行=1-19 从上往下，1=顶部row0）
    if (this.showCoords) {
      ctx.fillStyle = th.coord;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = 0; i < size; i++) {
        ctx.fillText(COLS[i], pad + i * cs, pad / 2);
        ctx.fillText(COLS[i], pad + i * cs, pad + (size - 1) * cs + pad / 2);
        ctx.fillText(String(i + 1), pad / 2, pad + i * cs);
        ctx.fillText(String(i + 1), pad + (size - 1) * cs + pad / 2, pad + i * cs);
      }
    }

    // 6. 势力热力图（空格键切换显示；静态，随 updateState 重建）
    if (this.showInfluence && this.influence) {
      this._drawInfluence(ctx);
    }

    // 7. 围空圈显示（半透明色块）
    if (this.showTerritory) {
      for (const enc of this.enclosures) {
        // 使用主题围空色：黑围空=深蓝，白围空=淡淡天青
        const color =
          enc.color === Color.BLACK
            ? `${this.theme.territoryBlack}0.25)`
            : `${this.theme.territoryWhite}0.68)`;
        ctx.fillStyle = color;
        for (const p of enc.points) {
          ctx.fillRect(pad + p.col * cs - cs / 2, pad + p.row * cs - cs / 2, cs, cs);
        }
      }
    }

    // 7b. 领土染色（纯视觉）：总分每相差 4 分，领跑方把对方领土最近边境的一格染成己方色
    this._drawScoreTerritory(ctx, pad, cs, size);

    // 8. 棋子
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const idx = r * size + c;
        const v = this.grid[idx];
        if (v === Color.EMPTY) continue;
        this._drawStone(c, r, v as Color, ctx);
        // 特种部队标记：仅在已落子处叠加（grid 已按视角隐藏对方未现形隐子，
        // 且 specialIdx 不含该格时不会画标记 → 双保险，绝不暴露隐藏位置）
        if (this.specialIdx.has(idx)) this._drawSpecialMark(c, r, ctx);
      }
    }

    // 9. 围困棋子标记（棋子中心的红色 ×，参考原项目 _draw_siege_cross_icon）
    if (this.showSieged) {
      const arm = cs * 0.45 * 0.225;
      const lw = Math.max(1.5, cs * 0.45 * 0.09);
      ctx.strokeStyle = "rgba(255, 40, 40, 0.95)";
      ctx.lineWidth = lw;
      for (const idx of this.siegedStones) {
        const r = Math.floor(idx / size);
        const c = idx % size;
        const cx = pad + c * cs;
        const cy = pad + r * cs;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy - arm);
        ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx - arm, cy + arm);
        ctx.lineTo(cx + arm, cy - arm);
        ctx.stroke();
      }
    }

    // 10. 战争迷雾覆盖（深靛紫色半透明迷雾，神秘压抑感，隐藏对方棋子）
    if (this.fogActive && this.fogCells.size > 0) {
      ctx.fillStyle = "rgba(52, 44, 92, 0.72)";
      for (const idx of this.fogCells) {
        const r = Math.floor(idx / size);
        const c = idx % size;
        ctx.fillRect(pad + c * cs - cs / 2, pad + r * cs - cs / 2, cs, cs);
      }
    }
  }

  // 领土染色（纯视觉）：总分领先方把对方领土的「方格」染成己方色。
  // 这里染的是交叉点之间的格子（cell），不遮挡落子交叉点、不盖棋子。
  // 变色格数 = floor(双方总分差 / 2)；从靠近边境线的那一行整行开始，向纵深逐行填充。
  private _drawScoreTerritory(ctx: CanvasRenderingContext2D, pad: number, cs: number, size: number): void {
    if (this.scoreBlack === this.scoreWhite) return;
    const leader = this.scoreBlack > this.scoreWhite ? Color.BLACK : Color.WHITE;
    let n = Math.floor(Math.abs(this.scoreBlack - this.scoreWhite) / 2);
    if (n <= 0) return;

    // 对方半区里、交叉点之间的方格：方格行 cr = 交叉点 cr 与 cr+1 之间的格子。
    // 黑领跑 → 染白半区（下方，边境线在交叉点9）：贴边境格 cr=9，向纵深下方推进至 17。
    // 白领跑 → 染黑半区（上方）：贴边境格 cr=8，向纵向上方推进至 0。
    const crStart = leader === Color.BLACK ? 9 : 8;
    const crMin = leader === Color.BLACK ? 9 : 0;
    const crMax = leader === Color.BLACK ? 17 : 8;
    const sign = leader === Color.BLACK ? 1 : -1;

    // 染成领跑方领土同色系、略深以区分侵占区（与半区底色一致协调）
    ctx.fillStyle = leader === Color.BLACK
      ? `${this.theme.territoryBlack}0.24)`
      : `${this.theme.territoryWhite}0.28)`;

    for (let cr = crStart; cr >= crMin && cr <= crMax; cr += sign) {
      for (let cc = 0; cc < size - 1; cc++) {
        if (n <= 0) return;
        const x = pad + cc * cs + cs / 2;
        const y = pad + cr * cs + cs / 2;
        ctx.fillRect(x - cs / 2, y - cs / 2, cs, cs);
        n--;
      }
    }
  }

  // 边境线：把第9行横网格线染色为红色，随呼吸微调明暗（动态层）
  // 只在没有棋子的边境段绘制呼吸亮线，避免压到棋子（棋子盖线）
  private _drawBorderZone(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;
    const t = (this.time % 2.0) / 2.0;
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    const alpha = this.borderPulse ? 0.35 + 0.4 * pulse : 0.55;
    const y = pad + BORDER_ROW * cs;
    ctx.strokeStyle = `rgba(${BORDER_RGB}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(1.5, cs * 0.05);
    ctx.beginPath();
    const has = (r: number, c: number) => this.grid[r * BOARD_SIZE + c] !== Color.EMPTY;
    for (let c = 0; c < BOARD_SIZE - 1; c++) {
      if (has(BORDER_ROW, c) || has(BORDER_ROW, c + 1)) continue;
      ctx.moveTo(pad + c * cs, y);
      ctx.lineTo(pad + (c + 1) * cs, y);
    }
    ctx.stroke();
  }

  // 波光粼粼：每 SPARKLE_PERIOD 秒一次，持续 SPARKLE_WINDOW 秒。
  // 在空格内绘制错峰闪烁的光斑（像水面反光），叠加在静态层上方，不覆盖棋子。
  private _drawGlimmer(): void {
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;
    const ph = this.time % SPARKLE_PERIOD;
    // 渐入-保持-渐出 envelope
    let env = 0;
    if (ph < 0.7) env = ph / 0.7;
    else if (ph < 2.1) env = 1;
    else if (ph < SPARKLE_WINDOW) env = (SPARKLE_WINDOW - ph) / (SPARKLE_WINDOW - 2.1);
    if (env <= 0) return;
    const size = BOARD_SIZE;
    // 每周期伪随机挑选一个起波角（四角之一），波浪沿对角线冲向对角
    const cycle = Math.floor(this.time / SPARKLE_PERIOD);
    const dir = (cycle * 57 + 13) % 4;
    const p = ph / SPARKLE_WINDOW; // 波前进度 0..1
    const BAND = 0.1; // 波前亮带宽度
    // 遍历 18×18 个由相邻行列线围成的方格（非交叉点）
    for (let gr = 0; gr < size - 1; gr++) {
      for (let gc = 0; gc < size - 1; gc++) {
        // 方格相对棋盘的对角线进度（0=起点角，1=对角）
        const tr = gr / (size - 2);
        const tc = gc / (size - 2);
        let q: number;
        if (dir === 0) q = (tr + tc) / 2; // 左上 → 右下
        else if (dir === 1) q = 1 - (tr + tc) / 2; // 右下 → 左上
        else if (dir === 2) q = (tr + (1 - tc)) / 2; // 右上 → 左下
        else q = ((1 - tr) + tc) / 2; // 左下 → 右上
        const bright = Math.max(0, 1 - Math.abs(q - p) / BAND);
        if (bright <= 0) continue;
        // 均匀填色（避免集中于方格中心），黑白随机分布
        const cellA = bright * 0.5 * env;
        const h = Math.sin(gr * 12.9898 + gc * 78.233) * 43758.5453;
        const rgb = (h - Math.floor(h)) > 0.5 ? "248, 250, 255" : "18, 20, 26";
        ctx.fillStyle = `rgba(${rgb}, ${cellA.toFixed(3)})`;
        // 把大方格拆成 4 个四分之一格：仅在该角无棋子的格子上闪光，
        // 避免波光覆盖棋子本身，同时让有棋子的方格周围仍有波光。
        // 用单条路径合并同一格的所有空角矩形再一次性填充（非零环绕=取并集），
        // 消除相邻矩形间的分割线。
        const half = cs / 2;
        ctx.beginPath();
        for (let cr = 0; cr < 2; cr++) {
          for (let cc = 0; cc < 2; cc++) {
            if (this.grid[(gr + cr) * size + (gc + cc)] !== Color.EMPTY) continue;
            ctx.rect(
              pad + (gc + cc * 0.5) * cs,
              pad + (gr + cr * 0.5) * cs,
              half,
              half
            );
          }
        }
        ctx.fill();
      }
    }
  }

  // 势力热力图：空点按双方影响力差值着色（黑=冷蓝，白=暖金）
  // target 指定绘制上下文（默认主 ctx；静态层重建时传入 staticCtx）
  private _drawInfluence(target?: CanvasRenderingContext2D): void {
    if (!this.influence || this.influence.maxAbs <= 0) return;
    const ctx = target ?? this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;
    const map = this.influence.map;
    const invMax = 1 / this.influence.maxAbs;
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        const idx = r * BOARD_SIZE + c;
        // 棋子点不显示（被棋子覆盖）
        if (this.grid[idx] !== Color.EMPTY) continue;
        const diff = map[idx];
        if (diff === 0) continue;
        const strength = Math.abs(diff) * invMax;
        const x = pad + c * cs - cs / 2;
        const y = pad + r * cs - cs / 2;
        if (diff > 0) {
          // 黑方势力：冷蓝
          ctx.fillStyle = `rgba(80, 140, 255, ${(strength * 0.5).toFixed(3)})`;
        } else {
          // 白方势力：暖金
          ctx.fillStyle = `rgba(255, 190, 80, ${(strength * 0.5).toFixed(3)})`;
        }
        ctx.fillRect(x, y, cs, cs);
      }
    }
  }

  // 打吃（剩最后一口气）呼吸灯：橙色外环呼吸 + 内圈脉冲
  private _drawAtariMarkers(): void {
    if (this.atariStones.size === 0) return;
    const ctx = this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;
    // 呼吸节奏：1s 周期
    const pulse = 0.5 + 0.5 * Math.sin(this.time * Math.PI * 2);
    const radius = cs * 0.45;
    for (const idx of this.atariStones) {
      const r = Math.floor(idx / BOARD_SIZE);
      const c = idx % BOARD_SIZE;
      const cx = pad + c * cs;
      const cy = pad + r * cs;
      // 外层橙色呼吸环（半径随脉冲扩张）
      ctx.strokeStyle = `rgba(255, 140, 40, ${(0.45 + 0.4 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * (1.22 + pulse * 0.16), 0, Math.PI * 2);
      ctx.stroke();
      // 内圈淡黄脉冲（反相呼吸）
      ctx.strokeStyle = `rgba(255, 205, 90, ${(0.3 + 0.3 * (1 - pulse)).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.02, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 特效过期清理（startTime 由 _addOverlay 赋值，此处一定存在）。
  // 已从绘制中抽离：迷雾下特效不绘制，但过期逻辑必须照常执行
  private _pruneEffectOverlays(now: number): void {
    this.effectOverlays = this.effectOverlays.filter((ov) => now - (ov.startTime ?? 0) < ov.duration);
  }

  // 特效叠加层绘制（参考原项目 BoardView 各 _draw_*_effect）
  private _drawEffectOverlays(): void {
    const now = this.time;
    for (const ov of this.effectOverlays) {
      const t = Math.min(1, (now - (ov.startTime ?? 0)) / ov.duration);
      switch (ov.type) {
        case "move": this._drawMovePulse(ov, t); break;
        case "deploy_place": this._drawDeployPlacePulse(ov, t); break;
        case "capture": this._drawCaptureBurst(ov, t); break;
        case "siege": this._drawSiegeEffect(ov, t); break;
        case "siege_broken": this._drawSiegeBroken(ov, t); break;
        case "territory_formed": this._drawTerritoryFormed(ov, t); break;
        case "territory_lost": this._drawTerritoryLost(ov, t); break;
        case "opening": this._drawOpeningAnimation(ov, t); break;
      }
    }
  }

  private _cellPos(row: number, col: number): { x: number; y: number } {
    return { x: this.padding + col * this.cellSize, y: this.padding + row * this.cellSize };
  }

  // 落子脉冲：双层天青扩散环 + 中心闪光（原项目 _draw_move_pulse）
  private _drawMovePulse(ov: EffectOverlay, t: number): void {
    if (!ov.position) return;
    const { x, y } = this._cellPos(ov.position.row, ov.position.col);
    const alpha = Math.pow(1 - t, 1.2) * 0.85; // 更亮、更快衰减
    const baseR = this.cellSize * 0.45;
    // 内层亮环（紧凑扩散 + 高亮天青）
    this.ctx.strokeStyle = `rgba(0, 185, 210, ${alpha.toFixed(3)})`;
    this.ctx.lineWidth = 3;
    this.ctx.beginPath();
    this.ctx.arc(x, y, baseR * (0.9 + t * 0.45), 0, Math.PI * 2);
    this.ctx.stroke();
    // 外层扩散环（更大扩散、更淡青）
    this.ctx.strokeStyle = `rgba(76, 212, 232, ${(alpha * 0.6).toFixed(3)})`;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x, y, baseR * (1.15 + t * 1.9), 0, Math.PI * 2);
    this.ctx.stroke();
    // 中心闪光：缩拢亮点
    const glow = (1 - t) * 0.55;
    this.ctx.fillStyle = `rgba(216, 248, 255, ${glow.toFixed(3)})`;
    this.ctx.beginPath();
    this.ctx.arc(x, y, baseR * 0.5 * (1 - t * 0.6), 0, Math.PI * 2);
    this.ctx.fill();
  }

  // 布局落子脉冲：青绿色双层扩散环（原项目 _draw_deploy_place_pulse）
  private _drawDeployPlacePulse(ov: EffectOverlay, t: number): void {
    if (!ov.position) return;
    const { x, y } = this._cellPos(ov.position.row, ov.position.col);
    const alpha = (1 - t) * 0.6;
    const baseR = this.cellSize * 0.45;
    // 内层亮环
    this.ctx.strokeStyle = `rgba(89, 229, 165, ${alpha.toFixed(3)})`;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(x, y, baseR * (1 + t * 0.6), 0, Math.PI * 2);
    this.ctx.stroke();
    // 外层扩散环
    this.ctx.strokeStyle = `rgba(51, 178, 128, ${(alpha * 0.6).toFixed(3)})`;
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.arc(x, y, baseR * (1.2 + t * 1.6), 0, Math.PI * 2);
    this.ctx.stroke();
  }

  // 提子：被吃棋子留在原位，半径周期脉动"呼吸"且越来越快，整体颜色由不透明渐淡直至消失
  private _drawCaptureBurst(ov: EffectOverlay, t: number): void {
    const positions = ov.positions ?? [];
    if (positions.length === 0) return;
    const baseR = this.cellSize * 0.45;
    const stoneColor = ov.color ?? Color.BLACK; // 被吃棋子颜色
    const fill = stoneColor === Color.BLACK ? this.theme.blackLo : this.theme.whiteLo;
    const edge = stoneColor === Color.BLACK ? this.theme.blackEdge : this.theme.whiteEdge;
    // 呼吸加速：相位随 t 二次增长 → 瞬时频率随时间加快（全程累积约 3 次呼吸，越往末尾越快）
    const phase = Math.PI * 2 * 3 * t * t;
    // 颜色越来越淡直至消失：不透明度 1→0
    const alpha = Math.max(0, 1 - t);
    for (const p of positions) {
      const { x, y } = this._cellPos(p.row, p.col);
      const r = baseR * (0.55 + 0.35 * Math.sin(phase)); // 呼吸：半径周期脉动
      this.ctx.globalAlpha = alpha;
      this.ctx.fillStyle = fill;
      this.ctx.beginPath();
      this.ctx.arc(x, y, r, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.lineWidth = 1.5;
      this.ctx.strokeStyle = edge;
      this.ctx.stroke();
    }
    this.ctx.globalAlpha = 1;
  }

  // 围困形成：红色脉冲环（2层，原项目 _draw_siege_effect）
  private _drawSiegeEffect(ov: EffectOverlay, t: number): void {
    const stones = ov.stones ?? [];
    if (stones.length === 0) return;
    const alpha = 1 - t;
    const baseR = this.cellSize * 0.45;
    for (const s of stones) {
      const { x, y } = this._cellPos(s.row, s.col);
      this.ctx.strokeStyle = `rgba(229, 51, 26, ${(alpha * 0.7).toFixed(3)})`;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(x, y, baseR * (1.2 + t * 0.8), 0, Math.PI * 2);
      this.ctx.stroke();
      const t2 = Math.min(1, Math.max(0, (t - 0.2) / 0.8));
      if (t2 > 0) {
        this.ctx.strokeStyle = `rgba(204, 38, 26, ${((1 - t2) * 0.5).toFixed(3)})`;
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.arc(x, y, baseR * (1 + t2 * 1.5), 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }
  }

  // 围困解除：绿色光环扩散（原项目 _draw_siege_broken）
  private _drawSiegeBroken(ov: EffectOverlay, t: number): void {
    const stones = ov.stones ?? [];
    if (stones.length === 0) return;
    const alpha = 1 - t;
    const baseR = this.cellSize * 0.45;
    for (const s of stones) {
      const { x, y } = this._cellPos(s.row, s.col);
      this.ctx.strokeStyle = `rgba(51, 229, 102, ${(alpha * 0.7).toFixed(3)})`;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(x, y, baseR * (1.2 + t * 1.2), 0, Math.PI * 2);
      this.ctx.stroke();
      const t2 = Math.min(1, Math.max(0, (t - 0.2) / 0.8));
      if (t2 > 0) {
        this.ctx.strokeStyle = `rgba(77, 204, 77, ${((1 - t2) * 0.5).toFixed(3)})`;
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.arc(x, y, baseR * (1 + t2 * 1.8), 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }
  }

  // 围空形成：圈内光晕扩散 + 中心扩散环（原项目 _draw_territory_formed）
  private _drawTerritoryFormed(ov: EffectOverlay, t: number): void {
    const points = ov.points ?? [];
    if (points.length === 0) return;
    const alpha = 1 - t;
    const fill = ov.color === Color.BLACK ? "20, 20, 20" : "245, 245, 245";
    const cs = this.cellSize;
    // 圈内逐点光晕扩散（波纹效果）
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const { x, y } = this._cellPos(p.row, p.col);
      const delay = (i / points.length) * 0.3;
      const pt = Math.min(1, Math.max(0, (t - delay) / (1 - delay)));
      if (pt <= 0) continue;
      const ptAlpha = (1 - pt) * 0.6;
      const s = cs * 0.5 * (0.5 + pt * 0.8);
      this.ctx.fillStyle = `rgba(${fill}, ${ptAlpha.toFixed(3)})`;
      this.ctx.fillRect(x - s, y - s, s * 2, s * 2);
    }
    // 中心扩散环
    let cx = 0, cy = 0;
    for (const p of points) {
      const pos = this._cellPos(p.row, p.col);
      cx += pos.x; cy += pos.y;
    }
    cx /= points.length;
    cy /= points.length;
    const ringColor = ov.color === Color.BLACK ? "30, 30, 30" : "150, 200, 255";
    this.ctx.strokeStyle = `rgba(${ringColor}, ${(alpha * 0.5).toFixed(3)})`;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, this.cellSize * 0.45 * (1 + t * 4), 0, Math.PI * 2);
    this.ctx.stroke();
  }

  // 围空失守：灰色消散 + 边界红闪（原项目 _draw_territory_lost）
  private _drawTerritoryLost(ov: EffectOverlay, t: number): void {
    const points = ov.points ?? [];
    if (points.length === 0) return;
    const alpha = 1 - t;
    const cs = this.cellSize;
    for (const p of points) {
      const { x, y } = this._cellPos(p.row, p.col);
      // 灰色消散
      this.ctx.fillStyle = `rgba(128, 128, 128, ${(alpha * 0.4).toFixed(3)})`;
      this.ctx.fillRect(x - cs * 0.5, y - cs * 0.5, cs, cs);
      // 边界红闪
      this.ctx.strokeStyle = `rgba(229, 51, 26, ${(alpha * 0.6).toFixed(3)})`;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(x - cs * 0.5, y - cs * 0.5, cs, cs);
    }
  }

  // 开局过渡动画：以天元为中心的环形波光扩散。
  // 环波颜色与分布参照棋盘波光动画：逐格伪随机黑白。
  private _drawOpeningAnimation(_ov: EffectOverlay, t: number): void {
    const cs = this.cellSize;
    const pad = this.padding;

    // 环形波光从天元向外扩散
    const tw = t; // 0→1
    const ctx = this.ctx;
    const env = Math.sin(tw * Math.PI); // 0→1→0
    if (env <= 0.02) return;
    const maxR = Math.hypot(8.5, 8.5); // 天元到棋盘角远端格的最大格距
    const BAND = 1.6; // 环形波前亮带宽度（格）
    const p = tw * maxR; // 环形波前半径：0(天元) → maxR(边缘)
    for (let gr = 0; gr < 18; gr++) {
      const y = pad + gr * cs;
      const dr = gr + 0.5 - 9.0;
      for (let gc = 0; gc < 18; gc++) {
        const dc = gc + 0.5 - 9.0;
        const dist = Math.hypot(dr, dc);
        const bright = Math.max(0, 1 - Math.abs(dist - p) / BAND);
        if (bright <= 0.01) continue;
        const h = Math.sin(gr * 12.9898 + gc * 78.233) * 43758.5453;
        const rgb = h - Math.floor(h) > 0.5 ? "248, 250, 255" : "18, 20, 26";
        const alpha = (bright * env * 0.5).toFixed(3);
        if (alpha === "0.000") continue;
        ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
        ctx.fillRect(pad + gc * cs, y, cs, cs);
      }
    }
  }

  // target 指定绘制上下文（默认主 ctx；静态层重建时传入 staticCtx）
  private _drawStone(col: number, row: number, color: Color, target?: CanvasRenderingContext2D): void {
    const ctx = target ?? this.ctx;
    const cs = this.cellSize;
    const pad = this.padding;
    const cx = pad + col * cs;
    const cy = pad + row * cs;
    const th = this.theme;
    const radius = cs * 0.45;
    const hi = color === Color.BLACK ? th.blackHi : th.whiteHi;
    const lo = color === Color.BLACK ? th.blackLo : th.whiteLo;
    const edge = color === Color.BLACK ? th.blackEdge : th.whiteEdge;

    // 阴影
    ctx.beginPath();
    ctx.arc(cx + 1, cy + 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fill();

    // 棋子主体（带渐变）
    const grad = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
    grad.addColorStop(0, hi);
    grad.addColorStop(1, lo);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // 边框
    ctx.strokeStyle = edge;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // 特种部队标记：金色四角星（内凹菱形），叠加在特殊棋子上，黑白棋子均清晰可辨
  private _drawSpecialMark(col: number, row: number, ctx: CanvasRenderingContext2D): void {
    const cs = this.cellSize;
    const pad = this.padding;
    const cx = pad + col * cs;
    const cy = pad + row * cs;
    const outer = cs * 0.32;
    const inner = cs * 0.12;
    // 四角星：外顶点间距 45° 交替（上/右/下/左为外顶，对角内凹）
    ctx.beginPath();
    for (let k = 0; k < 8; k++) {
      const ang = (Math.PI / 4) * k; // 0 = 正上
      const rad = k % 2 === 0 ? outer : inner;
      const x = cx + Math.sin(ang) * rad;
      const y = cy - Math.cos(ang) * rad;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    // 填充半透明金 + 描边亮金，边缘柔和
    ctx.fillStyle = "rgba(255, 208, 64, 0.78)";
    ctx.fill();
    ctx.strokeStyle = "rgba(180, 128, 20, 0.95)";
    ctx.lineWidth = Math.max(1, cs * 0.05);
    ctx.stroke();
    // 中心核心点（提亮，双色棋子皆可见）
    ctx.beginPath();
    ctx.arc(cx, cy, inner * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 246, 200, 1)";
    ctx.fill();
  }

  // 动画循环：驱动特效 + 边境线呼吸灯持续重绘
  private _startAnimLoop(): void {
    if (this.animFrame !== null) return;
    const loop = () => {
      if (this._destroyed) {
        this.animFrame = null;
        return;
      }
      this.time = performance.now() / 1000;
      // 有活跃特效/打吃呼吸灯/边境线呼吸灯/布局辉光/波光窗口时持续重绘
      // （热力图已在静态层，无需每帧重绘）
      const hasActive =
        this.effectOverlays.length > 0 ||
        this.borderPulse ||
        this.atariStones.size > 0 ||
        this.deployPhase ||
        (this.sparkleEnabled && (this.time % SPARKLE_PERIOD) < SPARKLE_WINDOW);
      if (!hasActive && this.hoverPos === null) {
        this.animFrame = null;
        return;
      }
      this.render();
      this.animFrame = requestAnimationFrame(loop);
    };
    this.animFrame = requestAnimationFrame(loop);
  }

  private _bindEvents(): void {
    this.canvas.addEventListener("click", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const pos = this.pixelToBoard(x, y);
      if (pos) this.onCellClick?.(pos.row, pos.col);
    });

    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const pos = this.pixelToBoard(x, y);
      this.setHover(pos);
    });

    this.canvas.addEventListener("mouseleave", () => {
      this.setHover(null);
    });
  }
}
