// 应用入口：屏幕切换
// M1: 本地对战（黑白交替，同一台机器）
// M2/M3: 在线对战（连接服务器）

import { GameScreen } from "./screens/GameScreen.js";
import { LifeDeathGameScreen } from "./screens/LifeDeathGameScreen.js";
import { OnlineGameScreen } from "./screens/OnlineGameScreen.js";
import { ReplayScreen } from "./screens/ReplayScreen.js";
import type { SocketClient } from "./net/SocketClient.js";
import { saveLedgerLocal, loadLedgerLocal } from "./net/ledgerBank.js";
import { loadAllAccountsLocal, loadAccountLocal } from "./net/accountsBank.js";
import { login, register, recover, type AuthSession } from "./net/authClient.js";
import type {
  GameStartPayload,
  MatchFoundPayload,
  IdentityKind,
  AccountRecord,
} from "@warhorn/shared";
import { verifyLedger, rebuildPlayers } from "@warhorn/shared";
import type { Ledger, LedgerPlayer } from "@warhorn/shared";
import { Color, AI_DIFFICULTY_NAMES, AIDifficulty, getPuzzleList } from "@warhorn/engine";
import { t, tpl, getLang, setLang } from "./i18n.js";

type Mode = "local" | "ai" | "online" | "puzzle";

// 当前身份：guest=临时身份（免密直玩，不入天梯）；user=正式身份（计入天梯）
interface Identity {
  kind: IdentityKind;
  name: string;
  token?: string;
}

class App {
  private root: HTMLElement;
  private currentScreen: { el: HTMLElement; destroy?: () => void } | null = null;
  // 当前会话身份（正式账号登录后持久；临时身份名字在开始时填写）
  private identity: Identity = { kind: "guest", name: "" };

  constructor() {
    this.root = document.getElementById("app")!;
  }

  async start(): Promise<void> {
    // 刷新页恢复：若存在进行中的在线对局档案，直接进入对局并请求恢复
    const resumed = await this._tryResumeRecovery();
    if (!resumed) this._showNameScreen();
  }

  // 断线重连 / 刷新页恢复入口：校验本地恢复档案并重建在线对局界面
  private async _tryResumeRecovery(): Promise<boolean> {
    const { SocketClient } = await import("./net/SocketClient.js");
    const resume = SocketClient.readStoredResume();
    if (!resume) return false;

    return new Promise<boolean>((resolve) => {
      this._clearScreen();
      const loading = document.createElement("div");
      loading.className = "screen screen-centered";
      loading.innerHTML = `<div class="logo">${t("logo")}</div><div class="subtitle">${t("resumed")}</div>`;
      this.root.appendChild(loading);
      this.currentScreen = { el: loading, destroy: () => loading.remove() };

      const client = new SocketClient();
      client.onError = (p) => {
        // 恢复失败（如对局已结束）：清除档案并退回主界面
        if (p.message.includes("结束")) {
          client.disarmResume();
          client.disconnect();
          this._showNameScreen();
          resolve(false);
        } else {
          this._showToast(p.message);
        }
      };
      const enterGame = (emitNow: boolean) => {
        const game = new OnlineGameScreen(client, resume.start);
        this.currentScreen?.destroy?.();
        this.root.appendChild(game.el);
        this.currentScreen = { el: game.el, destroy: () => game.destroy() };
        // 连接已就绪：立即发起一次恢复，服务器回 GAME_RECOVER 重建全盘
        client.armResume(resume, emitNow);
      };

      client.connect()
        .then(() => {
          this.identity = { kind: "guest", name: resume.name };
          client.joinLobby(resume.name);
          enterGame(true);
          resolve(true);
        })
        .catch(() => {
          client.disconnect();
          this._showNameScreen();
          resolve(false);
        });
      // 待恢复期间若连接中断：由 socket 自动重连，重连后仍会重发恢复请求
    });
  }

  private _showNameScreen(): void {
    this._clearScreen();
    const screen = document.createElement("div");
    screen.className = "screen screen-centered name-screen";
    screen.innerHTML = `
      <div class="war-bg" aria-hidden="true">
        <div class="war-grid"></div>
        <div class="war-glow"></div>
        <div class="war-smoke s1"></div>
        <div class="war-smoke s2"></div>
        <div class="war-smoke s3"></div>
        <div class="war-lines"></div>
      </div>
      <header class="war-head">
        <span class="war-star">★</span>
        <h1 class="logo">${t("logo")}</h1>
        <p class="subtitle">${t("subtitle")}</p>
        <div class="war-seals"><span>玄武</span><em>·</em><span>烽火</span><em>·</em><span>苍狼</span></div>
      </header>
      <div class="form">
        <div class="mode-tabs">
          <button class="btn active" data-mode="local">${t("mode.local")}</button>
          <button class="btn" data-mode="online">${t("mode.online")}</button>
          <button class="btn" data-mode="puzzle">${t("mode.puzzle")}</button>
        </div>
        <div class="ai-options hidden">
          <div class="ai-options-label">${t("ai.difficulty")}</div>
          <div class="mode-tabs" id="ai-diff">
            <button class="btn active" data-diff="0">${t("ai.easy")}</button>
            <button class="btn" data-diff="1">${t("ai.normal")}</button>
            <button class="btn" data-diff="2">${t("ai.hard")}</button>
          </div>
        </div>
        <div class="fog-options">
          <label class="checkbox">
            <input type="checkbox" id="fog-toggle" />
            <span class="chk-track"><span class="chk-knob"></span></span>
            <span class="chk-label">${t("fog.toggle")}</span>
          </label>
          <span class="fog-hint">${t("fog.hint")}</span>
        </div>
        <div class="fog-options">
          <label class="checkbox">
            <input type="checkbox" id="special-toggle" />
            <span class="chk-track"><span class="chk-knob"></span></span>
            <span class="chk-label">${t("special.toggle")}</span>
          </label>
          <span class="fog-hint">${t("special.hint")}</span>
        </div>
        <div class="identity-box">
          <div class="mode-tabs" id="identity-tabs">
            <button class="btn active" data-ident="guest">${t("ident.guest")}</button>
            <button class="btn" data-ident="user">${t("ident.user")}</button>
          </div>
          <div id="ident-banner" class="hidden">
            <span>${t("ident.loggedIn")}：<b id="ident-banner-name"></b></span>
            <button class="btn btn-sm" id="ident-logout">${t("ident.logout")}</button>
          </div>
          <div id="ident-guest" class="ident-fields">
            <input class="text-input" id="name-input" placeholder="${t("name.placeholder")}" maxlength="12" />
          </div>
          <div id="ident-user" class="ident-fields hidden">
            <div class="auth-tabs" id="auth-tabs">
              <button class="auth-tab active" data-authmode="login">${t("ident.login")}</button>
              <button class="auth-tab" data-authmode="register">${t("ident.register")}</button>
            </div>
            <div class="ident-fields" id="auth-login">
              <input class="text-input" id="login-email" type="email" placeholder="${t("ident.email")}" />
              <input class="text-input" id="login-pass" type="password" placeholder="${t("ident.password")}" />
              <div class="ident-err" id="login-err"></div>
              <button class="btn btn-primary btn-block" id="login-btn">${t("ident.login")}</button>
            </div>
            <div class="ident-fields hidden" id="auth-register">
              <input class="text-input" id="reg-email" type="email" placeholder="${t("ident.email")}" />
              <input class="text-input" id="reg-pass" type="password" placeholder="${t("ident.password")}" />
              <input class="text-input" id="reg-nick" placeholder="${t("ident.nickname")}" maxlength="20" />
              <div class="ident-err" id="register-err"></div>
              <button class="btn btn-primary btn-block" id="register-btn">${t("ident.register")}</button>
            </div>
          </div>
        </div>
        <input class="text-input hidden" id="name-input-2" placeholder="${t("name.local2")}" maxlength="12" />
        <button class="btn btn-primary btn-large" id="start-btn">${t("start")}</button>
        <div class="lang-switch">
          <span class="label">${t("lang")}</span>
          <button class="btn lang-btn ${getLang() === "zh" ? "active" : ""}" data-lang="zh">中文</button>
          <button class="btn lang-btn ${getLang() === "en" ? "active" : ""}" data-lang="en">English</button>
        </div>
      </div>
      <div class="app-version" data-load-version></div>
      <button class="btn" id="menu-rules-btn">${t("rules.btn")}</button>
      <div class="modal-mask" id="menu-rules-modal" hidden>
        <div class="modal-rules">
          <div class="modal-rules-header"><span>${t("rules.title")}</span><button class="btn btn-sm" id="menu-rules-close">${t("close")}</button></div>
          <div class="modal-rules-body"><ol>${Array.from({ length: 9 }, (_, i) => i + 1).map((n) => `<li>${t("rules." + n)}</li>`).join("")}</ol></div>
        </div>
      </div>
      <div class="feedback">${t("feedback")}：<a href="mailto:shamdom888@outlook.com">shamdom888@outlook.com</a></div>
    `;
    this.root.appendChild(screen);
    this.currentScreen = { el: screen };

    // 语言切换：重渲染主菜单
    screen.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setLang((btn as HTMLElement).dataset.lang as "zh" | "en");
        this._showNameScreen();
      });
    });

    // 游戏规则弹窗
    const menuRulesModal = screen.querySelector<HTMLElement>("#menu-rules-modal")!;
    screen.querySelector("#menu-rules-btn")!.addEventListener("click", () => { menuRulesModal.hidden = false; });
    screen.querySelector("#menu-rules-close")!.addEventListener("click", () => { menuRulesModal.hidden = true; });
    menuRulesModal.addEventListener("click", (e) => { if (e.target === menuRulesModal) menuRulesModal.hidden = true; });

    let mode: Mode = "local";
    let difficulty: AIDifficulty = 1; // 默认普通
    let fog = false; // 战争迷雾（可选规则）开关
    let special = false; // 特种部队（可选规则）开关

    // 首页显示服务版本：用于核对当前部署是否为最新版
    const verEl = screen.querySelector(".app-version[data-load-version]") as HTMLElement;
    if (verEl) {
      fetch("/api/version")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { version?: string } | null) => {
          if (d?.version) verEl.textContent = `v${d.version}`;
        })
        .catch(() => {});
    }
    const nameInput = screen.querySelector("#name-input") as HTMLInputElement;
    const nameInput2 = screen.querySelector("#name-input-2") as HTMLInputElement;
    const aiOptions = screen.querySelector(".ai-options") as HTMLElement;
    const fogToggle = screen.querySelector("#fog-toggle") as HTMLInputElement;
    const specialToggle = screen.querySelector("#special-toggle") as HTMLInputElement;
    const startBtn = screen.querySelector("#start-btn") as HTMLButtonElement;

    // 战争迷雾开关（可与特种部队同时启用）
    fogToggle.addEventListener("change", () => {
      fog = fogToggle.checked;
    });

    // 特种部队开关（可与战争迷雾同时启用；同时启用时迷雾活跃期间不可部署）
    specialToggle.addEventListener("change", () => {
      special = specialToggle.checked;
    });

    // 模式切换
    screen.querySelectorAll(".mode-tabs .btn[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        screen.querySelectorAll(".mode-tabs .btn[data-mode]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        mode = (btn as HTMLElement).dataset.mode as Mode;
        nameInput.placeholder =
          mode === "local" ? t("name.black") : mode === "ai" ? t("name.ai") : t("name.placeholder");
        nameInput2.classList.toggle("hidden", mode !== "local");
        nameInput2.placeholder = mode === "local" ? t("name.white") : "";
        aiOptions.classList.toggle("hidden", mode !== "ai");
        // 在线/死活题模式暂不支持迷雾与特种部队，隐藏开关
        const hideRules = mode === "online" || mode === "puzzle";
        screen.querySelectorAll(".fog-options").forEach((el) =>
          el.classList.toggle("hidden", hideRules)
        );
      });
    });

    // AI 难度选择
    screen.querySelectorAll("#ai-diff .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        screen.querySelectorAll("#ai-diff .btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        difficulty = Number((btn as HTMLElement).dataset.diff) as AIDifficulty;
      });
    });

    // ====== 账户身份：guest(临时免密直玩，不入天梯) / user(正式账号，计入天梯) ======
    const identTabs = screen.querySelector("#identity-tabs") as HTMLElement;
    const identGuestBox = screen.querySelector("#ident-guest") as HTMLElement;
    const identUserBox = screen.querySelector("#ident-user") as HTMLElement;
    const identBanner = screen.querySelector("#ident-banner") as HTMLElement;
    const identBannerName = screen.querySelector("#ident-banner-name") as HTMLElement;
    const logoutBtn = screen.querySelector("#ident-logout") as HTMLButtonElement;
    const loginEmail = screen.querySelector("#login-email") as HTMLInputElement;
    const loginPass = screen.querySelector("#login-pass") as HTMLInputElement;
    const loginBtn = screen.querySelector("#login-btn") as HTMLButtonElement;
    const loginErr = screen.querySelector("#login-err") as HTMLElement;
    const authTabs = screen.querySelector("#auth-tabs") as HTMLElement;
    const authLoginBox = screen.querySelector("#auth-login") as HTMLElement;
    const authRegisterBox = screen.querySelector("#auth-register") as HTMLElement;
    const regEmail = screen.querySelector("#reg-email") as HTMLInputElement;
    const regPass = screen.querySelector("#reg-pass") as HTMLInputElement;
    const regNick = screen.querySelector("#reg-nick") as HTMLInputElement;
    const regBtn = screen.querySelector("#register-btn") as HTMLButtonElement;
    const registerErr = screen.querySelector("#register-err") as HTMLElement;

    let identityTab: "guest" | "user" = this.identity.kind === "user" ? "user" : "guest";
    let authMode: "login" | "register" = "login"; // 正式面板下切换 登录/注册

    // 渲染身份面板：已登录显示横幅；否则按 identityTab 显示 临时/正式 表单；正式面板内按 authMode 显登录/注册
    const renderIdentity = () => {
      identTabs.classList.toggle("hidden", this.identity.kind === "user");
      const loggedIn = this.identity.kind === "user";
      identBanner.classList.toggle("hidden", !loggedIn);
      if (loggedIn) identBannerName.textContent = this.identity.name;
      identGuestBox.classList.toggle("hidden", loggedIn || identityTab !== "guest");
      identUserBox.classList.toggle("hidden", loggedIn || identityTab !== "user");
      authLoginBox.classList.toggle("hidden", authMode !== "login");
      authRegisterBox.classList.toggle("hidden", authMode !== "register");
      authTabs.querySelectorAll(".auth-tab[data-authmode]").forEach((b) => {
        b.classList.toggle("active", (b as HTMLElement).dataset.authmode === authMode);
      });
      identTabs.querySelectorAll(".btn").forEach((b) => {
        b.classList.toggle("active", (b as HTMLElement).dataset.ident === identityTab);
      });
    };

    // 身份切换
    identTabs.querySelectorAll(".btn[data-ident]").forEach((btn) => {
      btn.addEventListener("click", () => {
        identityTab = (btn as HTMLElement).dataset.ident as "guest" | "user";
        renderIdentity();
      });
    });
    // 登录 / 注册 切换
    authTabs.querySelectorAll(".auth-tab[data-authmode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        authMode = (btn as HTMLElement).dataset.authmode as "login" | "register";
        renderIdentity();
      });
    });
    logoutBtn.addEventListener("click", () => {
      this.identity = { kind: "guest", name: "" };
      identityTab = "guest";
      authMode = "login";
      renderIdentity();
    });

    // 自动恢复：登录失败“账号不存在”但有本地备份 → 提示从本地备份恢复（防服务器丢失）
    const tryRestore = async (email: string): Promise<AuthSession | null> => {
      const backup = await loadAccountLocal(email.trim().toLowerCase());
      if (!backup) return null;
      if (!confirm(tpl("ident.restoreConfirm", backup.email))) return null;
      try {
        return await recover(backup);
      } catch (err) {
        this._showToast(err instanceof Error ? err.message : t("connFailed"));
        return null;
      }
    };

    loginBtn.addEventListener("click", async () => {
      const emailV = loginEmail.value.trim();
      const passV = loginPass.value;
      loginErr.textContent = "";
      if (!emailV || !passV) {
        loginErr.textContent = t("ident.fillAll");
        return;
      }
      try {
        const s = await login(emailV, passV);
        this.identity = { kind: "user", name: s.name, token: s.token };
        loginEmail.value = "";
        loginPass.value = "";
        renderIdentity();
        this._showToast(tpl("ident.welcome", s.name));
      } catch (err) {
        // 账号不存在且有本地备份 → 走恢复
        if (err instanceof Error) {
          const same = err.message.includes(t("ident.notFound"));
          const restored = same ? await tryRestore(emailV) : null;
          if (restored) {
            this.identity = { kind: "user", name: restored.name, token: restored.token };
            renderIdentity();
            this._showToast(tpl("ident.restored", restored.name));
            return;
          }
        }
        loginErr.textContent = err instanceof Error ? err.message : t("connFailed");
      }
    });

    regBtn.addEventListener("click", async () => {
      const emailV = regEmail.value.trim();
      const passV = regPass.value;
      const nickV = regNick.value.trim();
      registerErr.textContent = "";
      if (!emailV || !passV || !nickV) {
        registerErr.textContent = t("ident.fillAll");
        return;
      }
      try {
        const s = await register(emailV, passV, nickV);
        this.identity = { kind: "user", name: s.name, token: s.token };
        regEmail.value = "";
        regPass.value = "";
        regNick.value = "";
        authMode = "login";
        renderIdentity();
        this._showToast(tpl("ident.welcome", s.name));
      } catch (err) {
        registerErr.textContent = err instanceof Error ? err.message : t("connFailed");
      }
    });
    renderIdentity();

    // 开始
    const start = () => {
      // 正式身份进入在线对战：使用正式昵称与 token；临时身份使用输入的名字
      if (mode === "online") {
        if (this.identity.kind === "user") {
          this._showOnlineLobby(this.identity.name, this.identity);
          return;
        }
        const guestName = nameInput.value.trim() || t("name.default.player");
        this._showOnlineLobby(guestName, { kind: "guest", name: guestName });
        return;
      }
      const name = nameInput.value.trim() || (mode === "local" ? t("name.default.black") : t("name.default.player"));
      if (mode === "local") {
        const name2 = nameInput2.value.trim() || t("name.default.white");
        this._showLocalGame(name, name2, fog, special);
      } else if (mode === "ai") {
        this._showAIGame(name, difficulty, fog, special);
      } else if (mode === "puzzle") {
        this._showPuzzleGame(name);
      }
    };
    startBtn.addEventListener("click", start);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") start();
    });
    nameInput.focus();
  }

  private _showLocalGame(blackName: string, whiteName: string, fog: boolean = false, specialForces: boolean = false): void {
    this._clearScreen();
    const game = new GameScreen(blackName, whiteName, null, AIDifficulty.NORMAL, fog, specialForces);
    this.root.appendChild(game.el);
    this.currentScreen = { el: game.el, destroy: () => game.destroy() };

    // 退出按钮（返回主菜单）：追加到棋盘下方的控制栏
    const backBtn = document.createElement("button");
    backBtn.className = "btn";
    backBtn.textContent = t("back");
    backBtn.addEventListener("click", () => {
      if (confirm(t("backMenu"))) {
        this._showNameScreen();
      }
    });
    game.el.querySelector(".game-controls")!.appendChild(backBtn);
  }

  private _showAIGame(playerName: string, difficulty: AIDifficulty, fog: boolean = false, specialForces: boolean = false): void {
    this._clearScreen();
    // 玩家执黑，AI 执白
    const aiName = tpl("aiName", AI_DIFFICULTY_NAMES[difficulty]);
    const game = new GameScreen(playerName, aiName, Color.WHITE, difficulty, fog, specialForces);
    this.root.appendChild(game.el);
    this.currentScreen = { el: game.el, destroy: () => game.destroy() };

    const controls = game.el.querySelector(".game-controls")!;

    // 匹配状态提示（边下棋边匹配）
    const matchStatus = document.createElement("span");
    matchStatus.className = "match-status-inline hidden";
    controls.appendChild(matchStatus);

    // 匹配对手按钮：进入在线匹配队列，同时可继续与 AI 对弈
    let client: SocketClient | null = null;
    let matching = false;
    const resetMatchUI = () => {
      matching = false;
      client?.disconnect();
      client = null;
      this._resetMatchUI(matchBtn, matchStatus);
    };
    const matchBtn = document.createElement("button");
    matchBtn.className = "btn";
    matchBtn.textContent = t("matchOpponent");
    matchBtn.addEventListener("click", async () => {
      if (matching) {
        // 取消匹配
        resetMatchUI();
        return;
      }
      if (client) client.disconnect(); // 清理上次遗留连接，避免重复入队
      matching = true;
      matchStatus.classList.remove("hidden");
      matchStatus.textContent = t("matchingWait");
      matchBtn.textContent = t("matchingCancel");
      try {
        const { SocketClient } = await import("./net/SocketClient.js");
        client = new SocketClient();
        client.onMatchFound = (payload) => {
          this._showMatchConfirm(client!, payload, playerName);
        };
        client.onMatchCancelled = () => resetMatchUI();
        client.onGameStart = (payload) => {
          // 匹配成功并确认：切换至在线对局（放弃当前 AI 对局）
          matching = false; // 已进入在线对局，后续断线不再触发匹配重置
          this._showOnlineGame(client!, payload);
        };
        client.onError = (payload) => {
          this._showToast(payload.message);
          if (matching) resetMatchUI();
        };
        client.onDisconnect = () => {
          if (matching) {
            this._showToast(t("connLost"));
            resetMatchUI();
          }
        };
        await client.connect();
        client.joinLobby(playerName, this.identity.token);
        client.requestMatch();
      } catch (err) {
        this._showToast(t("connFailed"));
        console.error(err);
        resetMatchUI();
      }
    });
    controls.appendChild(matchBtn);

    // 退出按钮（返回主菜单）：若在匹配中则断开连接
    const backBtn = document.createElement("button");
    backBtn.className = "btn";
    backBtn.textContent = t("back");
    backBtn.addEventListener("click", () => {
      if (confirm(t("backMenu"))) {
        client?.disconnect();
        this._showNameScreen();
      }
    });
    controls.appendChild(backBtn);
  }

  private _resetMatchUI(btn: HTMLButtonElement, status: HTMLElement): void {
    btn.textContent = t("matchOpponent");
    status.classList.add("hidden");
  }

  private _showPuzzleGame(playerName: string): void {
    this._clearScreen();
    const puzzles = getPuzzleList();
    let client: SocketClient | null = null;

    const game = new LifeDeathGameScreen(puzzles, {
      playerName,
      onBack: () => {
        client?.disconnect();
        this._showNameScreen();
      },
      attachMatch: (pName) => {
        let cancelled = false;
        const doConnect = async () => {
          try {
            const { SocketClient: SC } = await import("./net/SocketClient.js");
            client = new SC();
            client.onMatchFound = (payload) => {
              this._showMatchConfirm(client!, payload, pName);
            };
            client.onMatchCancelled = () => {
              if (!cancelled) {
                // 界面 UI 复位由闯关界面自行重置（点击取消），连接对象保留
              }
            };
            client.onGameStart = (payload) => {
              this._showOnlineGame(client!, payload);
            };
            client.onError = (payload) => {
              this._showToast(payload.message);
            };
            client.onDisconnect = () => {
              if (!cancelled) this._showToast(t("connLost"));
            };
            await client.connect();
            client.joinLobby(pName, this.identity.token);
            client.requestMatch();
          } catch (err) {
            this._showToast(t("connFailed"));
            console.error(err);
          }
        };
        void doConnect();
        return { disconnect: () => { cancelled = true; client?.disconnect(); client = null; } };
      },
    });
    this.root.appendChild(game.el);
    this.currentScreen = { el: game.el, destroy: () => game.destroy() };
  }

  private _showOnlineLobby(name: string, identity: Identity): void {
    this._clearScreen();
    const screen = document.createElement("div");
    screen.className = "screen screen-centered lobby-screen";
    screen.innerHTML = `
      <div class="lobby-header war-header">
        <div class="war-brand">
          <svg class="war-emblem" viewBox="0 0 40 40" aria-hidden="true">
            <path d="M20 3 L35 12 V28 L20 37 L5 28 V12 Z" fill="none" stroke="currentColor" stroke-width="2"/>
            <path d="M20 11 L28 15.5 V24.5 L20 29 L12 24.5 V15.5 Z" fill="currentColor"/>
            <path d="M20 18 L22.4 21.2 L26 21.8 L23.5 24.2 L24.1 27.8 L20 26.2 L15.9 27.8 L16.5 24.2 L14 21.8 L17.6 21.2 Z" fill="currentColor"/>
          </svg>
          <div class="war-brand-text">
            <div class="war-brand-title">${t("lobbyTitle")}</div>
            <div class="war-brand-sub">ONLINE COMMAND · RANKED LOBBY</div>
          </div>
        </div>
        <div class="war-header-right">
          <span class="war-stamp">天梯战区 · 就绪</span>
          <button class="btn tight-btn" id="back-btn">${t("back")}</button>
        </div>
      </div>
      <div class="lobby-content">
        <div class="lobby-main">
          <div class="cmd-panel cmd-comms">
            <div class="cmd-panel-head">
              <span class="cmd-idx">C-01</span>
              <span class="cmd-title">${t("curSettings")}</span>
              <span class="cmd-tag">COMMS</span>
            </div>
            <div class="lobby-stats">
              <div class="lobby-stat">
                <span class="stat-led led-online"></span>
                <span class="label">${t("onlineCount")}</span>
                <span class="value" id="online-count">-</span>
              </div>
              <div class="lobby-stat">
                <span class="stat-led led-matching"></span>
                <span class="label">${t("matchingCount")}</span>
                <span class="value" id="matching-count">-</span>
              </div>
            </div>
            <div class="lobby-settings">
              <div class="lobby-settings-interior">
                <div class="lobby-settings-item">
                  <span class="label">${t("komi")}</span>
                  <span class="value" id="cfg-komi">-</span>
                </div>
                <div class="lobby-settings-item">
                  <span class="label">${t("piecesSide")}</span>
                  <span class="value" id="cfg-pieces">-</span>
                </div>
                <div class="lobby-settings-item">
                  <span class="label">${t("timing")}</span>
                  <span class="value" id="cfg-timer">-</span>
                </div>
                <div class="lobby-settings-item">
                  <span class="label">${t("deployTime")}</span>
                  <span class="value" id="cfg-deploy">-</span>
                </div>
              </div>
            </div>
            <div class="lobby-rules">
              <div class="fog-options" id="online-fog-wrap">
                <label class="checkbox"><input type="checkbox" id="online-fog-toggle" /><span class="chk-track"><span class="chk-knob"></span></span><span class="chk-label">${t("fog.toggle")}</span></label>
                <span class="fog-hint">${t("fog.hint")}</span>
              </div>
              <div class="fog-options" id="online-special-wrap">
                <label class="checkbox"><input type="checkbox" id="online-special-toggle" /><span class="chk-track"><span class="chk-knob"></span></span><span class="chk-label">${t("special.toggle")}</span></label>
                <span class="fog-hint">${t("special.hint")}</span>
              </div>
            </div>
            <div id="match-area">
              <button class="btn btn-primary btn-large cmd-match" id="match-btn">
                <span class="match-glyph">▶</span>${t("startMatch")}
              </button>
            </div>
            <div id="match-status" class="match-status hidden">
              <span class="spinner"></span>
              <span id="match-status-text">${t("matchingDots")}</span>
              <button class="btn cmd-cancel" id="match-cancel-btn">${t("cancelMatch")}</button>
            </div>
            <div class="cmd-foot">${t("practiceHint")}</div>
          </div>
        </div>
        <div class="lobby-side">
          <div class="lobby-leaderboard">
            <div class="rail-head">
              <span class="cmd-idx">I-01</span>
              <span class="cmd-title">${t("leaderboard.title")}</span>
            </div>
            <div id="leaderboard-wrap">${t("leaderboard.loading")}</div>
          </div>
          <div class="lobby-replays">
            <div class="rail-head">
              <span class="cmd-idx">I-02</span>
              <span class="cmd-title">${t("replay.recent")}</span>
            </div>
            <div id="replays-wrap">${t("replay.loading")}</div>
          </div>
        </div>
      </div>
    `;
    this.root.appendChild(screen);
    this.currentScreen = { el: screen };

    screen.querySelector("#back-btn")!.addEventListener("click", () => this._showNameScreen());

    // M2/M3 在线模式：连接服务器
    this._initOnline(screen, name, identity);
  }

  private async _initOnline(screen: HTMLElement, name: string, identity: Identity): Promise<void> {
    const matchBtn = screen.querySelector("#match-btn") as HTMLButtonElement;
    const matchArea = screen.querySelector("#match-area") as HTMLElement;
    const matchStatus = screen.querySelector("#match-status") as HTMLElement;
    const matchStatusText = screen.querySelector("#match-status-text") as HTMLElement;
    const onlineCount = screen.querySelector("#online-count") as HTMLElement;
    const matchingCount = screen.querySelector("#matching-count") as HTMLElement;
    const onlineFogToggle = screen.querySelector("#online-fog-toggle") as HTMLInputElement;
    const onlineSpecialToggle = screen.querySelector("#online-special-toggle") as HTMLInputElement;
    const cfgKomi = screen.querySelector("#cfg-komi") as HTMLElement;
    const cfgPieces = screen.querySelector("#cfg-pieces") as HTMLElement;
    const cfgTimer = screen.querySelector("#cfg-timer") as HTMLElement;
    const cfgDeploy = screen.querySelector("#cfg-deploy") as HTMLElement;
    const leaderboardWrap = screen.querySelector("#leaderboard-wrap") as HTMLElement;

    // 近期对局回放列表（公开数据）
    this._initRecentGames(screen);

    try {
      const { SocketClient } = await import("./net/SocketClient.js");
      const client = new SocketClient();

      client.onLobbyUpdate = (payload) => {
        onlineCount.textContent = String(payload.onlineCount);
        matchingCount.textContent = String(payload.matchingCount);
      };

      client.onMatchFound = (payload) => {
        matchStatus.classList.add("hidden");
        matchArea.classList.remove("hidden");
        this._showMatchConfirm(client, payload, name);
      };

      client.onMatchCancelled = () => {
        matchStatus.classList.add("hidden");
        matchArea.classList.remove("hidden");
      };

      client.onGameStart = (payload) => {
        this._showOnlineGame(client, payload);
      };

      client.onError = (payload) => {
        this._showToast(payload.message);
      };

      await client.connect();
      client.joinLobby(name, identity.token);

      // 天梯“我的名次”：仅正式身份(user)匹配本地昵称高亮；临时身份不显示“我”
      const meName = identity.kind === "user" ? identity.name : "";

      // 拉取服务器当前游戏设置（大厅展示）
      client
        .fetchConfig()
        .then((cfg) => {
          cfgKomi.textContent = tpl("komiUnit", cfg.komi);
          cfgPieces.textContent = tpl("stonesUnit", cfg.pieceLimit);
          cfgTimer.textContent = tpl("byoRule", this._fmtDuration(cfg.timerBaseSec), cfg.byoCount, cfg.byoPeriodSec);
          cfgDeploy.textContent = this._fmtDuration(cfg.deployTimerSec);
        })
        .catch((err) => {
          console.warn("获取游戏设置失败", err);
        });

      // 天梯：拉取全链 → 验签 → 本地冗余存档 → 按链重建排名展示
      // 收到广播（每局结束）时刷新本地副本与排名
      client.onLedgerUpdate = (ledger) => {
        this._handleLedgerBroadcast(ledger, leaderboardWrap, meName, client);
      };
      this._initLeaderboard(client, leaderboardWrap, meName);

      matchBtn.addEventListener("click", () => {
        matchArea.classList.add("hidden");
        matchStatus.classList.remove("hidden");
        matchStatusText.textContent = t("matchingDots");
        client.requestMatch(onlineFogToggle.checked, onlineSpecialToggle.checked);
      });

      const matchCancelBtn = screen.querySelector("#match-cancel-btn") as HTMLButtonElement;
      matchCancelBtn.addEventListener("click", () => {
        matchStatus.classList.add("hidden");
        matchArea.classList.remove("hidden");
        client.cancelMatch();
      });
    } catch (err) {
      this._showToast(t("connFailed"));
      console.error(err);
    }
  }

  private _renderLeaderboard(wrap: HTMLElement, res: import("./net/SocketClient.js").LeaderboardPayload, myName: string): void {
    if (!res.top.length) {
      wrap.textContent = t("leaderboard.noRank");
      return;
    }
    const rows = res.top
      .map((r) => {
        const isMe = r.name === myName;
        const esc = this._escape(r.name);
        return `<div class="lb-row${isMe ? " lb-me" : ""}">
          <span class="lb-rank">#${r.rank}</span>
          <span class="lb-name">${esc}</span>
          <span class="lb-rating">${r.rating}</span>
          <span class="lb-wl">${r.wins}${t("leaderboard.wins")}/${r.losses}${t("leaderboard.losses")}</span>
        </div>`;
      })
      .join("");
    const meBanner = res.me
      ? `<div class="lb-me-banner">${t("leaderboard.myRank")}: #${res.me.rank} · ${res.me.rating}${t("leaderboard.rating")} · ${res.me.wins}${t("leaderboard.wins")}/${res.me.losses}${t("leaderboard.losses")}</div>`
      : "";
    wrap.innerHTML = meBanner + rows;
  }

  // 天梯日志：拉取服务器全链 → 验签 → 本地冗余存档 → 按链重建排名
  private async _initLeaderboard(client: SocketClient, wrap: HTMLElement, name: string): Promise<void> {
    wrap.textContent = t("leaderboard.loading");
    try {
      const { ledger } = await client.fetchLedger();
      if (!ledger || !ledger.blocks?.length) {
        wrap.textContent = t("leaderboard.noRank");
        return;
      }
      const v = await verifyLedger(ledger);
      if (!v.ok) {
        console.warn("[ledger] 拉取账本验签失败", v);
        wrap.textContent = t("leaderboard.noRank");
        return;
      }
      await saveLedgerLocal(ledger); // 本地冗余
      this._renderFromLedger(wrap, ledger, name);
    } catch (err) {
      console.warn("[ledger] 拉取账本失败", err);
      wrap.textContent = t("leaderboard.noRank");
    }
  }

  // 处理服务器广播的账本全链：验签 → 本地存档 → 刷新排名
  private async _handleLedgerBroadcast(ledger: Ledger, wrap: HTMLElement, name: string, client: SocketClient): Promise<void> {
    if (!ledger || !ledger.blocks?.length) return;
    const v = await verifyLedger(ledger);
    if (!v.ok) {
      console.warn("[ledger] 广播账本验签失败", v);
      return;
    }
    await saveLedgerLocal(ledger); // 更新本地冗余副本
    this._renderFromLedger(wrap, ledger, name);
  }

  // 从账本重建玩家数据并复用排名渲染
  private _renderFromLedger(wrap: HTMLElement, ledger: Ledger, myName: string): void {
    try {
      const players = rebuildPlayers(ledger);
      if (!players.length) {
        wrap.textContent = t("leaderboard.noRank");
        return;
      }
      const sorted = [...players].sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.games - b.games);
      const top = sorted.slice(0, 10).map((p, i) => ({ ...p, rank: i + 1 }));
      const idx = sorted.findIndex((p) => p.name === myName);
      const me = idx === -1 ? null : { ...sorted[idx], rank: idx + 1 };
      this._renderLeaderboard(wrap, { top, me }, myName);
    } catch (err) {
      console.warn("[ledger] 从账本重建排名失败", err);
    }
  }

  private _showReplay(gameId: string, backToLobby: boolean): void {
    this._clearScreen();
    const replay = new ReplayScreen(
      gameId,
      backToLobby ? () => this._showOnlineLobbyFromStack() : () => this._showNameScreen()
    );
    this.root.appendChild(replay.el);
    this.currentScreen = { el: replay.el, destroy: () => replay.destroy() };
  }

  // 回放后返回在线大厅（简化：回大厅需重连，复用主菜单入口逻辑）
  private _showOnlineLobbyFromStack(): void {
    this._showNameScreen();
  }

  // 拉取最近对局公开数据并渲染到大厅列表；点击进入回放屏
  private async _initRecentGames(screen: HTMLElement): Promise<void> {
    const wrap = screen.querySelector("#replays-wrap") as HTMLElement;
    const loading = (msg: string) => {
      const el = document.createElement("div");
      el.className = "replay-item replay-item-empty";
      el.textContent = msg;
      wrap.replaceChildren(el);
    };
    try {
      const res = await fetch("/api/games?limit=10");
      if (!res.ok) {
        loading(t("replay.loadFail"));
        return;
      }
      const data = await res.json();
      const games: Array<{
        id: string;
        black: string;
        white: string;
        winnerColor: number;
        finalBlack: number;
        finalWhite: number;
        endedAt: number;
      }> = data.games ?? [];
      if (!games.length) {
        loading(t("replay.recentEmpty"));
        return;
      }
      const items = games
        .map((g) => {
          const esc = (s: string) => this._escape(s);
          const winnerName = g.winnerColor === Color.BLACK ? t("black") : t("white");
          return `<button class="replay-item" data-id="${g.id}">
            <span class="replay-item-match">${esc(g.black)} vs ${esc(g.white)}</span>
            <span class="replay-item-score">黑 ${g.finalBlack} : ${g.finalWhite} 白</span>
            <span class="replay-item-winner">${esc(tpl("win", winnerName))}</span>
          </button>`;
        })
        .join("");
      wrap.innerHTML = items;
      wrap.querySelectorAll(".replay-item[data-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._showReplay((btn as HTMLElement).dataset.id!, true);
        });
      });
    } catch (err) {
      console.warn("[replay] 拉取近期对局失败", err);
      loading(t("replay.loadFail"));
    }
  }

  private _showMatchConfirm(client: SocketClient, payload: MatchFoundPayload, _ownName: string): void {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
      <div class="modal">
        <h2>${t("matchFound")}</h2>
        <div class="modal-body">
          <p>${tpl("opponentLabel", this._escape(payload.opponentName))}</p>
          <p>${tpl("yourColor", t(payload.ownColor === 1 ? "black" : "white"))}</p>
          ${payload.fogEnabled ? `<p style="font-size:12px; color:var(--accent);">${t("fog.toggle")}</p>` : ""}
          ${payload.specialForces ? `<p style="font-size:12px; color:var(--accent);">${t("special.toggle")}</p>` : ""}
          <div class="countdown" id="countdown">${payload.confirmTimeoutSec}</div>
          <p style="font-size:12px; color:var(--text-dim);">${t("confirmIn")}</p>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" id="confirm-btn">${t("startGame")}</button>
          <button class="btn btn-danger" id="decline-btn">${t("decline")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    let count = payload.confirmTimeoutSec;
    const countdownEl = modal.querySelector("#countdown")!;
    const timer = setInterval(() => {
      count--;
      countdownEl.textContent = String(count);
      if (count <= 0) {
        clearInterval(timer);
        modal.remove();
      }
    }, 1000);

    modal.querySelector("#confirm-btn")!.addEventListener("click", () => {
      clearInterval(timer);
      client.confirmMatch();
      modal.remove();
    });
    modal.querySelector("#decline-btn")!.addEventListener("click", () => {
      clearInterval(timer);
      client.declineMatch();
      modal.remove();
    });
  }

  private _showOnlineGame(client: SocketClient, payload: GameStartPayload): void {
    this._clearScreen();
    const game = new OnlineGameScreen(client, payload);
    this.root.appendChild(game.el);
    this.currentScreen = { el: game.el, destroy: () => game.destroy() };
  }

  private _clearScreen(): void {
    if (this.currentScreen) {
      this.currentScreen.destroy?.();
      this.currentScreen.el.remove();
      this.currentScreen = null;
    }
    // 清理可能残留的弹窗（对局结束 / 匹配确认），避免盖住新界面
    document.querySelectorAll(".modal-overlay").forEach((m) => m.remove());
  }

  private _showToast(msg: string): void {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  private _fmtDuration(sec: number): string {
    if (sec >= 60 && sec % 60 === 0) return tpl("fmt.min", sec / 60);
    if (sec >= 60) return tpl("fmt.minSec", Math.floor(sec / 60), sec % 60);
    return tpl("fmt.sec", sec);
  }

  private _escape(s: string): string {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }
}

const app = new App();
app.start();
