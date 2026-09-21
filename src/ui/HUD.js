import { ELEMENTS, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';

/**
 * 抬头显示（HUD）：技能栏、操作说明、实时统计数据与提示气泡。
 *
 * 纯 DOM 实现——不用任何框架。技能栏由 `ELEMENTS` 构建，因此新增技能
 * 会自动出现在栏中；技能槽是唯一可交互的部分，并通过 `onAbility` 映射
 * 键盘快捷键。
 *
 * 冷却扫层是一个由 CSS 自定义属性驱动的 `conic-gradient`，所以每帧更新
 * 只需一次 `setProperty` 调用，且不会触碰布局。
 */
export class HUD {
    constructor(root) {
        this.root = root;
        this.onAbility = null;
        this._toastTimer = 0;
        this._statsAccumulator = 0;
        this._frames = 0;
        this._fps = 0;
        /** 上次推送到 DOM 的扫层比例，按元素记录。 */
        this._cooldownShown = new Map();
        this._armedShown = null;

        root.innerHTML = `
      <div class="hud__panel hud__title">
        Elemental Sandbox
        <span data-blurb>Press Q, E, R, F, V or X, aim, click to cast.</span>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>Particles <b data-stat="particles">0</b></div>
        <div>Instances <b data-stat="spikes">0</b></div>
        <div>Draw calls <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>Q</strong> — Frost Lance &nbsp; <strong>E</strong> — Storm Lance</div>
        <div><strong>R</strong> — Cinder Fall &nbsp; <strong>F</strong> — Nova Beam</div>
        <div><strong>V</strong> — Voltaic Snare &nbsp; <strong>X</strong> — Glacial Crown</div>
        <div class="hud__help-note">V and X are far casts — aimed with a circle, not an arrow.</div>
        <div><strong>Move</strong> — aim &nbsp; <strong>Left click</strong> — cast</div>
        <div><strong>Esc / right click</strong> — cancel the cast</div>
        <div><strong>Right drag</strong> — orbit &nbsp; <strong>Scroll</strong> — zoom</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> editor &nbsp; <kbd>P</kbd> pause &nbsp; <kbd>C</kbd> clear
        </div>
        <div><kbd>H</kbd> hide this</div>
        <div class="hud__help-note">Paused still applies every editor change.</div>
      </div>

      <div class="hud__abilities">
        ${ELEMENTS.map((element) => {
            const meta = ELEMENT_META[element];
            return `
            <div class="ability-card" data-element="${element}" style="--accent:${meta.accent}">
              <div class="ability-card__sweep" data-sweep></div>
              <div class="ability-card__key">${meta.key}</div>
              <div class="ability-card__glyph">${ELEMENT_SIGILS[element] ?? ''}</div>
              <div class="ability-card__label">${meta.label}</div>
            </div>`;
        }).join('')}
      </div>

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>Paused</div>
    `;

        this.cards = new Map();
        for (const card of root.querySelectorAll('.ability-card')) {
            this.cards.set(card.dataset.element, card);
            card.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                this.onAbility?.(card.dataset.element);
            });
        }

        this.stats = {
            fps: root.querySelector('[data-stat="fps"]'),
            particles: root.querySelector('[data-stat="particles"]'),
            spikes: root.querySelector('[data-stat="spikes"]'),
            calls: root.querySelector('[data-stat="calls"]'),
        };
        this.help = root.querySelector('.hud__help');
        this.toast = root.querySelector('[data-toast]');
        this.pausedBadge = root.querySelector('[data-paused]');
        this.abilityBar = root.querySelector('.hud__abilities');
    }

    /** @param {{silent?: boolean}} [options] */
    setElement(element, options = {}) {
        for (const [key, card] of this.cards) {
            card.classList.toggle('is-active', key === element);
        }
        const meta = ELEMENT_META[element];
        if (meta && !options.silent) this.showToast(`${meta.hint} selected`);
    }

    /** 施放处于备战状态时高亮对应的技能槽。 */
    setArmed(armed) {
        if (armed === this._armedShown) return;
        this._armedShown = armed;
        this.abilityBar.classList.toggle('is-armed', armed);
    }

    /**
     * 驱动单个技能槽的冷却扫层。冷却是按技能各自计算的，所以这个方法
     * 每帧对每个元素各调用一次。
     *
     * @param {string} element
     * @param {number} remaining 剩余秒数
     * @param {number} total     完整冷却时长，用于计算扫层角度
     */
    setCooldown(element, remaining, total) {
        const card = this.cards.get(element);
        if (!card) return;

        const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
        // 只有当扫层可见地移动时才触碰 DOM。
        if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
        this._cooldownShown.set(element, ratio);
        card.style.setProperty('--cooldown', ratio);
        card.classList.toggle('is-cooling', ratio > 0.001);
    }

    setPaused(paused) {
        this.pausedBadge.classList.toggle('is-visible', paused);
    }

    toggleHelp() {
        this.help.classList.toggle('is-hidden');
    }

    showToast(message, duration = 1600) {
        this.toast.textContent = message;
        this.toast.classList.add('is-visible');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
    }

    /**
     * @param {number} dt
     * @param {() => {particles:number, spikes:number, calls:number}} collect
     *   仅在读数真正刷新时才被调用，因此采集数字（意味着遍历粒子池）不会
     *   落在热路径上。
     */
    update(dt, collect) {
        this._frames++;
        this._statsAccumulator += dt;
        if (this._statsAccumulator < 0.4) return;

        this._fps = Math.round(this._frames / this._statsAccumulator);
        this._frames = 0;
        this._statsAccumulator = 0;

        const info = collect();
        this.stats.fps.textContent = this._fps;
        this.stats.particles.textContent = info.particles;
        this.stats.spikes.textContent = info.spikes;
        this.stats.calls.textContent = info.calls;
    }
}

/** 启动画面辅助类。 */
export class LoadingScreen {
    constructor() {
        this.element = document.getElementById('loader');
        this.fill = document.getElementById('loader-fill');
        this.status = document.getElementById('loader-status');
    }

    setProgress(ratio, message) {
        this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
        if (message) this.status.textContent = message;
    }

    hide() {
        this.setProgress(1);
        setTimeout(() => this.element.classList.add('is-hidden'), 220);
    }

    fail(message) {
        this.status.textContent = message;
        this.status.style.color = '#ff7a6a';
    }
}
