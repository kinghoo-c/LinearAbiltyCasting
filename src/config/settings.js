/**
 * settings.js —— 沙盒中每一个可调值的唯一真源。
 *
 * 渲染器里没有任何东西拥有存放在这里的状态：着色器、粒子系统、
 * 灯光与后期处理每帧都只是*读取*这些对象。正是这一点
 * 让实时编辑器无需重建任何东西就能工作——改动一个字段
 * 立刻就能在屏幕上看到，包括在一座已经立起来的冰原上，
 * 也包括在时钟暂停（`P`）时，而那正是这些
 * 形态真正值得调的时候。
 *
 * 维持这一承诺的唯一规则：系统只允许*采样*这些
 * 值。它永远不得在生成时把某个值复制进一条记录、之后再读回来
 * ——见 `IceAbility`，它的冰刺记录里只有无单位的掷骰结果，
 * 每一米、每一弧度、每一秒都在每帧针对本文件重新解算。
 *
 * 约定
 *  - 颜色保存为 `#rrggbb` 字符串，这样 lil-gui 可以直接绑定它们。
 *    用 `utils/color.js#getColor()` 把它们读成带缓存的 THREE.Color。
 *  - `global` 存放一次性缩放所有东西的乘数（1 = 中性）。
 *  - 各能力块（`ice`、`thunder`、`meteor`、`beam`）存放绝对值。
 *
 * 每个能力块都以它在 `ELEMENTS` 中的 id 为键，那些需要
 * 知道“玩家当前手持哪个能力”的共享系统——瞄准
 * 控制器、冷却、HUD——都用 `settings[element]` 去查它。
 * 它们依赖必须存在的四个字段是 `range`、`minRange`、`speed`
 * 和 `cooldown`；块里其余的一切都是该能力自己的事。
 * 一次**远距施放**（`CastShape.ZONE`，在 `ELEMENT_META` 中声明）会加上第五个：
 * `zoneRadius`，也就是圆形指示器量出的落点范围。
 */

/**
 * 随骨骼一起提供的施放动画，位于 `public/models/<id>.fbx`。
 *
 * 每个能力块都带有一个 `castAnim` 来指定其中之一，这样每个法术
 * 都能用不同的方式抛出身体；`CharacterController` 在启动时一次性加载全部，
 * 并且只保留它们的剪辑，编辑器则把这个数组直接
 * 变成每个能力的下拉选项。
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
    /* ------------------------------------------------------------------ */
    /* 全局乘数                                                           */
    /* ------------------------------------------------------------------ */
    global: {
        timeScale: 1.0, // 整个模拟的慢动作 / 快进
        speed: 1.0, // 爆发传播速度乘数
        lifetime: 1.0, // 能力存活时长乘数
        glow: 1.0, // 送入泛光的自发光乘数
        shaderIntensity: 1.0, // 所有程序化着色器效果的总体强度
        noiseStrength: 1.0,
        noiseFrequency: 1.0,
        noiseSpeed: 1.0,
        turbulence: 1.0,
        randomness: 1.0, // 逐实例 / 逐粒子的抖动乘数
        particleCount: 1.0,
        particleLifetime: 1.0,
        particleSpeed: 1.0,
        particleSize: 1.0,
        emissionRate: 1.0,
        lightIntensity: 1.0,
        lightRadius: 1.0,
        distortion: 1.0,
        fresnel: 1.0,
        opacity: 1.0,
        animationSpeed: 1.0, // 角色动画播放速率
        cameraShake: 1.0,
        explosionIntensity: 1.0,
    },

    /* ------------------------------------------------------------------ */
    /* 瞄准指示器 —— 进入备战状态时绘制的地面箭头                         */
    /* ------------------------------------------------------------------ */
    /**
     * 一个 League 风格的技能弹道指示器：单个地面四边形，其片元着色器里是
     * 有符号距离场画出的箭头，所以下面每个尺寸都以*米*为单位，没有一个贴图。
     * 这个四边形每帧都按这些数字重建，这也是为什么瞄准时拖动 `range`
     * 能实时拉伸箭头。
     */
    aim: {
        /* --- 轮廓（米） --- */
        shaftWidth: 0.42, // 箭杆的半宽
        headLength: 2.6, // 箭头的长度
        headWidth: 1.35, // 箭头根部处的半宽
        round: 0.12, // 整个轮廓的圆角
        startOffset: 0.9, // 施放者与箭头尾部之间的间隙

        /* --- 渲染 --- */
        edge: 0.09, // 描边厚度，米
        edgeGlow: 2.6, // 描边泛光的强度
        softness: 0.06, // 外边缘的羽化
        fill: 0.3, // 内部底色填充的不透明度
        fillFalloff: 1.1, // 填充从轴线到边缘淡出的速度
        opacity: 1.0,

        /* --- 沿箭杆涌动的能量 --- */
        stripes: 0.55, // 每米的 V 形条纹数
        stripeSharp: 0.62, // 0 = 柔和渐变，1 = 硬边条纹
        stripeDepth: 0.55, // 它们对填充的调制幅度
        scrollSpeed: 2.4, // 它们朝箭头尖端行进的速度，米/秒
        pulse: 0.28, // 亮度的呼吸起伏
        pulseSpeed: 2.2,

        /* --- 霜冻的破碎 --- */
        noise: 0.45, // 噪声侵蚀填充的程度
        noiseScale: 1.6, // 每米的纹理特征数
        noiseSpeed: 0.35,
        crystals: 0.55, // 覆盖在内部的 voronoi 霜冻板块
        crystalScale: 2.4,

        /* --- 附加构件 --- */
        baseRing: 0.62, // 施放者脚下圆环的半径，米
        baseRingWidth: 0.06,
        tipGlyph: 0.9, // 命中点处水晶玫瑰纹的强度
        tipGlyphSize: 1.15, // 该玫瑰纹的半径，米
        tipSpin: 0.45, // 转/秒
        rangeArc: 0.55, // 最大射程端帽的亮度
        reveal: 0.055, // 备战状态下箭头扫出所需的秒数

        /* --- 颜色 --- */
        colorCore: '#ecfbff',
        colorEdge: '#3fb4ff',
        colorInvalid: '#ff6a5c', // 目标位于 `minRange` 之内时显示

        height: 0.035, // 悬浮于地面之上的距离，米
    },

    /* ------------------------------------------------------------------ */
    /* 远距施放指示器 —— 在目标点绘制的圆                                 */
    /* ------------------------------------------------------------------ */
    /**
     * 瞄准语汇的另一半。`aim` 沿一条线画箭头，
     * 这里画的则是**落点范围**：一个落在光标处的圆盘，
     * 带有一圈刻意加粗的边界，因为地面指向的
     * AoE 在你点击之前必须回答的唯一问题是*这要占多大地方*。
     * 那条边带就是答案，而能力自身的场被做得正好落在
     * 它上面。
     *
     * 两个网格，都是参数化的：
     *  - **落点范围**，一个四边形，其片元着色器是从目标点以米为单位
     *    求解的有符号距离圆环；
     *  - **射程环**，一条在施放者脚下以 `range` 弯成圆形的带状条
     *    ——远距施放需要显示它的臂展到哪里结束。
     *
     * 被所有远距施放共用，所以新的远距施放会继承整套指示器，
     * 只需要带上自己的 `zoneRadius`。
     */
    zone: {
        /* --- 边界（米） --- */
        boundary: 0.34, // *就是*落点范围边缘的那条边带的厚度
        // 刻意压在 2 以下：这条边带已经是圆上最宽的标记，把增益
        // 推过这个值会把它削成一片死白，丢掉那个
        // 说明你正在手持哪个能力的色调。
        boundaryGlow: 1.8, // 它泛光的强度
        boundaryBias: 0.35, // <0.5 让边带向内生长，>0.5 向外
        liner: 0.05, // 贴着边带内侧的细亮衬线
        softness: 0.05, // 两侧边唇的羽化

        /* --- 内部 --- */
        fill: 0.22, // 圆内底色填充的不透明度
        fillFalloff: 1.5, // >1 让中间保持干净、把填充挤向边缘
        rings: 2.0, // 横跨半径的同心等高环
        ringWidth: 0.05,
        ringSpeed: 0.35, // 它们向外行进的速度，半径/秒
        crawl: 0.75, // 在内部爬行的丝状物
        crawlScale: 1.3, // 每米的丝状物数量
        crawlSpeed: 0.45,
        noise: 0.4, // 侵蚀底色的破碎
        noiseScale: 1.2,

        /* --- 附加构件 --- */
        ticks: 24, // 沿边界一圈排布的刻度标记
        tickLength: 0.42, // 它们向内延伸的距离，米
        tickWidth: 0.2, // 占空比，0..1
        tickSpin: 0.06, // 转/秒
        sweep: 0.55, // 雷达扫描的亮度
        sweepSpeed: 0.4, // 转/秒
        core: 0.85, // 精确落在目标点上的标记
        coreSize: 0.4, // 它的半径，米
        crosshair: 0.5, // 从核心向外伸出的四条臂
        crosshairLength: 1.1,
        pulse: 0.22, // 亮度的呼吸起伏
        pulseSpeed: 2.0,

        /* --- 施放者处的射程环 --- */
        reach: 0.7, // 最大射程圆的亮度，0 表示隐藏
        reachWidth: 0.05, // 它的半宽，米
        reachDashes: 64, // 它上面的虚线段数（0 = 实线）
        reachDashGap: 0.42, // 每段虚线中属于间隙的比例
        reachSpin: 0.03, // 虚线段缓慢移动的速度，转/秒
        reachLead: 0.9, // 最靠近光标的那段弧亮多少
        reachSegments: 192, // 该圆的细分段数

        /* --- 渲染 --- */
        opacity: 1.0,
        reveal: 0.07, // 备战时这个圆弹出所需的秒数
        snap: 1.18, // 弹出时越过自身半径的幅度
        height: 0.035, // 悬浮于地面之上的距离，米

        /* --- 颜色 --- */
        colorCore: '#eaf7ff',
        colorEdge: '#7c6bff',
        colorInvalid: '#ff6a5c', // 目标位于 `minRange` 之内时显示
    },

    /* ------------------------------------------------------------------ */
    /* 角色                                                                */
    /* ------------------------------------------------------------------ */
    character: {
        /* --- 把施放剪辑叠加到待机之上 --- */
        // 待机动作永远循环；施放剪辑是叠在它之上的一次性动作，
        // 所以这两个值就是那次叠加的两端。进得快，出得柔：抛出
        // 必须落在你点击的那一帧上，而恢复不必。
        castBlendIn: 0.12, // 从待机交叉淡入施放的秒数
        castBlendOut: 0.3, // 施放结束后退回待机的秒数

        /* --- 身体如何把这次施放演出来 --- */
        turnToAim: true, // 瞄准时转向箭头
        turnRate: 0.0002, // 1 秒后剩余的朝向差比例（越小越干脆）
        castLean: 0.34, // 释放时躯干前倾的弧度
        castRecoil: 0.16, // 身体被向后推的米数
        castSettle: 2.6, // 前冲衰减的速率，秒⁻¹
    },

    /* ================================================================== */
    /* ICE —— 能力一                                                      */
    /* ================================================================== */
    /**
     * 一场冰川般的喷发：一道断裂前沿沿着瞄准的直线疾冲而出，其身后
     * 一片水晶尖刺从地面撕开涌出，在施放者附近又小又密，
     * 在远端则高大而猛烈。
     *
     * 一切都是生成的——这些水晶是程序化几何体
     * （`assets/ProceduralGeometry.js`），它们的着色是一份打过补丁的标准
     * 材质（`materials/IceMaterial.js`），霜冻是四边形上的一个着色器，
     * 而雾气、碎屑与闪光则是 GPU 粒子。磁盘上没有任何贴图，
     * 也没有任何网格。
     */
    ice: {
        /* --- 施放本身 --- */
        range: 15.0, // 最大施放距离，米
        minRange: 2.5, // 比这更近则拒绝施放
        speed: 26.0, // 断裂前沿行进的速度，米/秒
        lifetime: 3.6, // 冰原站立多少秒后收回
        cooldown: 0.4, // 再次进入备战状态所需的秒数
        castAnim: 'cast3', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 尖刺填充的落点范围 --- */
        widthNear: 0.55, // 施放者处这条带的半宽，米
        width: 2.5, // 远端的半宽，米
        widthCurve: 0.75, // <1 早早张开，>1 先保持狭窄再展开
        spikeCount: 190, // 一次施放消耗的实例数（上限 288）
        density: 1.0, // 该数量的乘数
        clumping: 1.35, // >1 把尖刺拉向中心线
        scatter: 0.55, // 额外的横向抖动，以局部半宽为比例
        frontBias: 0.85, // <1 把尖刺挤向命中点

        /* --- 冰原的轮廓 --- */
        heightNear: 0.5, // 施放者处的尖刺高度，米
        height: 3.1, // 远端的尖刺高度，米
        heightCurve: 1.7, // 这段升势爬升得有多晚
        heightJitter: 0.55,
        crown: 0.55, // 侧翼冰刃比中脊矮多少，0..1
        peak: 1.45, // 命中点处额外的高度乘数
        peakWidth: 0.28, // 那处隆起覆盖这条线的多少，0..1
        rubble: 0.42, // 降级为脚踝高碎片的尖刺比例
        rubbleScale: 0.3,

        /* --- 单个水晶 --- */
        radius: 0.41, // 底部半径，米
        radiusJitter: 0.93,
        taper: 0.69, // 尖端半径占底部的比例
        facets: 7, // 棱柱的侧面数（5–8 读起来最好）
        roughness: 0.09, // 各个面相对干净棱柱被推离的程度
        bend: 0.66, // 从底部到尖端的侧向弯曲
        lean: 0.42, // 尖刺偏离施放者倾斜的弧度
        leanJitter: 1.5,
        twist: 1.0, // 随机偏航，以整圈的比例表示，0..1

        /* --- 喷发 --- */
        riseTime: 0.17, // 从埋在地下到全高所需的秒数
        riseOvershoot: 0.26, // 这一记冲击越过全高的幅度
        riseStagger: 0.09, // 相邻个体之间随机延迟的秒数
        settle: 0.55, // 过冲阻尼掉所需的秒数
        shatterDelay: 0.6, // `lifetime` 之后再过多少秒它们开始碎裂
        sinkTime: 1.0, // 收回地下的秒数

        /* --- 冰材质 --- */
        colorDeep: '#3e737a', // 厚冰逐渐趋向的颜色
        colorIce: '#8adaff', // 主体
        colorRim: '#f2feff', // 菲涅尔边缘
        colorCore: '#638797', // 困在新鲜水晶内部的光
        opacity: 0.92,
        depthTint: 1.15, // 深色色调随厚度累积的速度
        fresnel: 2.3,
        fresnelPower: 2.4,
        translucency: 1.5, // 从背后透出的光
        envIntensity: 0.9, // 各个面捕捉到多少 HDR 探针
        facetSharp: 0.68, // 内部面着色的锐利度
        fracture: 0.62, // 内部的裂纹平面
        fractureScale: 6.5, // 每米的裂纹数
        veins: 0.45, // 水晶内部的乳白色羽状霜
        veinScale: 3.2,
        // 刻意命名为 `glint*` 而不是 `sparkle*`：这些是水晶*表面*上
        // 针尖般的强光点，而再往下的 `sparkle*` 一族驱动的是闪光
        // *粒子*。两种不同的效果。
        glint: 1.1,
        glintScale: 34.0,
        glintSpeed: 0.7,
        frostLine: 0.5, // 沿水晶向上攀爬的白霜条带
        glow: 0.85, // 自发光的总增益
        edgeGlow: 1.1, // 轮廓边缘的亮度
        birthGlow: 1.6, // 刚刚喷出的水晶上额外的辉光
        birthFade: 0.45, // 那次诞生闪光持续的秒数

        /* --- 地面做了什么 --- */
        frostSpread: 1.35, // 霜冻斑块的半径，× 局部半宽
        frostRate: 3.6, // 前沿每行进一米铺设的斑块数
        frostLife: 7.0, // 一个斑块滞留的秒数
        frostIntensity: 0.85,
        frostCrystals: 1.5, // 压实的雪的颗粒感
        colorFrost: '#f0f9ff', // 雪受光的一面
        colorFrostEdge: '#79b6dd', // 它在自身阴影中变成的颜色
        shockRadius: 5.5, // 命中冲击波圆环，米
        colorShockA: '#5fd0ff', // 冲击波圆环的主体
        colorShockB: '#f2feff', // 它的波峰

        /* --- 雾气、碎屑与闪光 --- */
        /**
         * 每个粒子系统的着色都来自一条四段渐变，按粒子自身的
         * 生命周期采样：`A` 是它诞生的瞬间，`D` 是它消亡之时。这里把它们
         * 逐一写出来而不是从水晶调色板推导，这样就能把雾调暖、
         * 或给闪光重新上色，而完全不碰冰本身。
         */
        mistRate: 260, // 翻滚的地面雾，粒子/秒
        mistSize: 1.15,
        mistSpeed: 1.3,
        mistLifetime: 2.8,
        mistOpacity: 0.05,
        mistRise: 0.35, // 雾上升的速度，米/秒
        colorMistA: '#f2feff',
        colorMistB: '#cdefff',
        colorMistC: '#a9e4ff',
        colorMistD: '#09304c',
        shardRate: 150, // 喷发抛出的冰屑
        shardSize: 0.075,
        shardSpeed: 7.0,
        shardLifetime: 1.7,
        shardGravity: -14.0,
        colorShardA: '#f2feff',
        colorShardB: '#a9e4ff',
        colorShardC: '#a9e4ff',
        colorShardD: '#12496f',
        sparkleRate: 130, // 升腾的闪光羽流
        sparkleSize: 0.055,
        sparkleSpeed: 3.4,
        sparkleLifetime: 2.6,
        sparkleRise: 1.6, // 向上漂移，米/秒
        sparkleTurbulence: 0.55,
        colorSparkleA: '#f2feff',
        colorSparkleB: '#57c9ff',
        colorSparkleC: '#a9e4ff',
        colorSparkleD: '#041e32',

        /* --- 动态光 --- */
        lightIntensity: 9,
        lightRadius: 13,
        lightColor: '#7fd4ff',

        /* --- 远端的命中 --- */
        burstSize: 3.6,
        burstIntensity: 0.75,
        burstShards: 90, // 命中时额外抛出的碎屑
        impactShake: 0.7,
        impactFlash: 0.12,
        shakeDuration: 0.9,
        rumble: 0.06, // 前沿行进期间的持续震动
        // 霜冻外壳在它翻滚的噪声上混合 A→B，并把 C 铺在
        // 结晶的板块和菲涅尔边缘上，所以读起来发烫的是 C。
        colorBurstA: '#a9e4ff',
        colorBurstB: '#cdefff',
        colorBurstC: '#f2feff',
        colorFlash: '#f2feff', // 命中时全屏的闪光
    },

    /* ================================================================== */
    /* THUNDER —— 能力二                                                  */
    /* ================================================================== */
    /**
     * 一道从施放者手中沿着瞄准直线掷出的闪电：一束
     * 闪电丝，凭空炸现、在摇曳中维持、然后
     * 炸开消散。外观参考：`thundercast.jpg`。
     *
     * 这道闪电是**一个网格**。每一根丝都是同一条带状
     * 条的实例，它全部的形态——轴线的下垂、束的扇形展开、
     * 单根丝上的折角、朝向相机的宽度——都在
     * 顶点着色器中由下面的数字求值。路径上没有任何东西存在于
     * CPU 上，这正是为什么调 `strands`、`jitter` 和 `spread` 能重塑一道
     * 已经在空中的闪电，而且在时钟暂停时也照样做。
     *
     * 一次施放*确实*会捕捉的唯一一样东西是 `uSeed`，一个在生成时
     * 掷出的随机数，好让两次施放不会画出完全一样的闪电。那是一个
     * 事件，而不是一个维度——与 `IceAbility` 遵循同样的规则。
     */
    thunder: {
        /* --- 施放 --- */
        range: 24.0, // 最大施放距离，米
        minRange: 2.0, // 比这更近则拒绝施放
        speed: 105.0, // 打击前沿行进的速度，米/秒
        lifetime: 0.45, // 闪电落地后维持的秒数
        fadeTime: 0.5, // 炸开消散所需的秒数
        cooldown: 0.5,
        castAnim: 'cast2', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 闪电离开施放者的位置 --- */
        // 光束从手部开始，而不是从脚部，所以这些值
        // 是在施放自身的坐标系里、从施放者原点量起的。
        handHeight: 1.28, // 距地面的米数
        handForward: 0.55, // 在施放者前方的米数
        handSide: 0.16, // 向侧面的米数（+ 跟随 `Ability#side`）
        endHeight: 0.35, // 闪电落点处的高度，米
        sag: 0.22, // 中段向上弓起的米数（负值则下垂）

        /* --- 这一束丝 --- */
        strands: 9, // 彼此分开的丝数（上限 24）
        spread: 0.75, // 这束在远端展开的米数
        spreadNear: 0.05, // ……以及在手部
        spreadCurve: 1.6, // >1 让这束先保持收紧、之后再张开
        twist: 0.45, // 这束沿轴在其长度上绕的圈数
        twistSpeed: 0.8, // 在那之上它自转的速度，圈/秒
        branchDim: 0.72, // 外侧的丝比中脊暗多少

        /* --- 单根丝的形状 --- */
        jitter: 0.34, // 最粗那一阶的折角米数
        jitterScale: 0.85, // 每米的折角数
        octaves: 4, // 1–5；每一阶把振幅减半、频率加倍
        jitterFalloff: 0.55, // 每一阶保留的振幅
        crawl: 3.2, // 折角沿闪电滑动的速度
        pinch: 0.14, // 两端被拉直的那一段占整个跨度的比例
        converge: 0.8, // 远端被拉到目标上的强度，0..1

        /* --- 带状条 --- */
        width: 0.025, // 一根丝在手部处的半宽，米
        widthTip: 0.43, // 该宽度在命中点处占的比例
        widthCurve: 1.09, // 收细发生得有多早
        coreWidth: 1.31, // 中央中脊的乘数
        coreSharp: 4.95, // 炽热核心在带状条上衰减的强度
        glowWidth: 5.7, // 光晕，× 核心宽度
        glowFalloff: 2.4, // 光晕在它自己的带状条上淡出的速度
        glowOpacity: 0.49,
        softFade: 0.78, // 闪电与几何体相交处柔和淡出的米数

        /* --- 闪烁与重击 --- */
        restrike: 24, // 这些丝每秒重掷形状的次数
        flicker: 0.3, // 整道闪电亮度抖动的深度
        flickerSpeed: 34, // 抖动次数/秒
        strandFlash: 0.5, // 单根丝熄灭的程度
        tipGlow: 2.0, // 行进时前缘上额外的热量
        tipLength: 0.08, // 该前缘的长度，以跨度的比例表示

        /* --- 颜色 --- */
        colorCore: '#ffffff', // 一根丝的中心
        colorInner: '#c9ecff',
        colorOuter: '#3aa0ff', // 一根丝的外侧
        colorHalo: '#0b3fc8', // 环绕这束丝的宽大辉光
        glow: 2.3, // 自发光的总增益
        opacity: 1.0,

        /* --- 地面做了什么 --- */
        arcRate: 0.9, // 前沿每行进一米铺设的电灼痕数
        arcRadius: 1.5, // 一道灼痕的半径，米
        arcLife: 0.6, // 一道灼痕滞留的秒数
        arcIntensity: 1.0,
        arcBranches: 0.6, // 灼痕分裂成细丝的精细程度
        scorchRadius: 0.5, // 闪电下方深色灼烧痕迹的米数
        scorchLife: 6.5,
        scorchIntensity: 0.45,
        colorArc: '#9fdcff',
        colorScorch: '#080b11',
        colorEmber: '#4aa8ff',
        shockRadius: 6.5, // 命中冲击波圆环，米
        colorShockA: '#c9ecff', // 冲击波圆环的主体
        colorShockB: '#ffffff', // 它的波峰

        /* --- 火花、微尘、烟与碎屑 --- */
        /**
         * 与 `ice` 中一样：每个系统的着色都来自一条四段渐变，按粒子自身的
         * 生命周期采样，`A` 在诞生时，直到 `D` 消亡时。这里逐一写出来
         * 而不是从闪电调色板推导，这样就能让火花冷却成橙色，
         * 而丝仍旧保持蓝色。
         */
        sparkRate: 240, // 闪电抛出的火花，粒子/秒
        sparkSize: 0.16,
        sparkSpeed: 9.0,
        sparkLifetime: 0.5,
        sparkGravity: -12.0,
        sparkStretch: 0.18, // 一颗火花沿其速度方向拖出的长度
        colorSparkA: '#ffffff',
        colorSparkB: '#ffffff',
        colorSparkC: '#c9ecff',
        colorSparkD: '#1e5b95',
        moteRate: 90, // 从闪电上缓慢漂离的电离微尘
        moteSize: 0.05,
        moteSpeed: 1.5,
        moteLifetime: 1.6,
        moteRise: 1.0, // 向上漂移，米/秒
        moteTurbulence: 0.7,
        colorMoteA: '#ffffff',
        colorMoteB: '#c9ecff',
        colorMoteC: '#3aa0ff',
        colorMoteD: '#02195f',
        smokeRate: 50, // 从灼烧地面上散出的薄雾
        smokeSize: 1.0,
        smokeSpeed: 1.1,
        smokeLifetime: 2.2,
        smokeOpacity: 0.06,
        smokeRise: 0.55,
        colorSmokeA: '#3d546e',
        colorSmokeB: '#33475e',
        colorSmokeC: '#33475e',
        colorSmokeD: '#1c2938',
        debrisRate: 24, // 从闪电下方的地面踢起的碎屑
        debrisSize: 0.055,
        debrisSpeed: 5.0,
        debrisLifetime: 1.3,
        debrisGravity: -17.0,
        colorDebrisA: '#252c36',
        colorDebrisB: '#1c222a',
        colorDebrisC: '#1c222a',
        colorDebrisD: '#1c222a',

        /* --- 动态光 --- */
        lightIntensity: 26,
        lightRadius: 17,
        lightColor: '#63b8ff',
        lightFlicker: 0.4, // 灯光摇曳的深度，0 = 稳定
        lightFlickerSpeed: 26,

        /* --- 出射口与命中处 --- */
        // 两个外壳用的是同一个着色器：A→B 在翻滚的噪声上混合，
        // 并且几乎保持空无，而 C 是奔跑的丝和菲涅尔
        // 边缘所用的颜色——所以承载可读性的是 C。
        muzzleSize: 0.55, // 手部的闪光，米
        muzzleIntensity: 1.9,
        castFlash: 0.1, // 释放时的屏幕闪光
        colorMuzzleA: '#3aa0ff',
        colorMuzzleB: '#c9ecff',
        colorMuzzleC: '#ffffff',
        colorCastFlash: '#c9ecff',
        burstSize: 3.0, // 命中点处的外壳，米
        burstIntensity: 1.4,
        burstSparks: 170, // 命中时额外抛出的火花
        burstDebris: 45,
        impactShake: 0.8,
        shakeDuration: 0.55,
        impactFlash: 0.28,
        rumble: 0.03, // 前沿行进期间的持续震动
        colorBurstA: '#3aa0ff',
        colorBurstB: '#c9ecff',
        colorBurstC: '#ffffff',
        colorFlash: '#c9ecff', // 命中时全屏的闪光
    },

    /* ================================================================== */
    /* METEOR —— 能力三                                                   */
    /* ================================================================== */
    /**
     * 一块燃烧的岩石沿着瞄准的直线抛出，抵达时引爆。
     *
     * 这块岩石是真实的几何体——一块由
     * `assets/ProceduralGeometry.js` 生成的布满陨坑、多面的小行星——用打过
     * 补丁的标准材质着色，因此它会投下并接收舞台的阴影。它的标志是**熔岩缝**：
     * 一个在岩石自身本地空间中采样的 fbm 场的零交叉，所以
     * 裂缝与它焊在一起、随它一同翻滚。`chargeCurve` 决定它们
     * 在飞来的路上张开的快慢。
     *
     * 在它身后拖着**火焰拖尾**：一个黑体体积，在沿着弧线铺设的
     * 朝向相机的代理外壳内做光线步进。见 `trail*` 那一块。
     *
     * 与 `ice` 和 `thunder` 一样，一次施放除了掷骰和时间戳以外什么也不捕捉：
     * 一个种子、一根翻滚轴，以及每块碎屑几个无单位的掷骰值。
     * 弹道、岩石的大小、缝的宽度，以及每块碎屑完整的
     * 抛体飞行，都在每帧针对这一块重新解算——
     * 这正是为什么拖动 `arc` 能把一块已经在空中的陨石重新抛起，
     * 拖动 `chunkSpeed` 能把已经落地的碎屑重新扔出去。
     */
    meteor: {
        /* --- 施放 --- */
        range: 20.0, // 最大施放距离，米
        minRange: 3.0, // 比这更近则拒绝施放
        speed: 21.0, // 岩石沿射向飞行的速度，米/秒
        lifetime: 2.2, // 命中山坑燃烧的秒数
        fadeTime: 1.6, // 一切消散所需的秒数
        cooldown: 0.9,
        castAnim: 'cast1', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 飞行路径 --- */
        // 岩石是从手中掷出的，所以这些值是在施放自身的坐标系里、
        // 从施放者原点量起的。
        handHeight: 1.35, // 距地面的米数
        handForward: 0.6, // 在施放者前方的米数
        handSide: 0.2, // 向侧面的米数（+ 跟随 `Ability#side`）
        endHeight: 0.75, // 岩石落点处的高度，米
        arc: 2.6, // 中段向上高抛的米数
        arcCurve: 0.85, // <1 压平弧顶，>1 让弧顶更尖

        /* --- 岩石 --- */
        radius: 0.8, // 米
        facets: 3, // icosphere 细分次数，0–3（3 = 1280 个三角形）
        lumpiness: 0.26, // 低频形变，× 半径
        lumpScale: 1.5, // 每单位半径的疙瘩数
        surfaceRoughness: 0.16, // 高频的崩缺
        cuts: 9, // 从它上面切掉的平面断裂面
        cutDepth: 0.28, // 这些平面切入的深度，× 半径
        craters: 5, // 打进去的撞击凹坑
        craterDepth: 0.18, // 这些凹坑的深度，× 半径
        craterSize: 0.5, // 它们的角半径，弧度
        spin: 3.4, // 翻滚速率，弧度/秒

        /* --- 熔岩缝 --- */
        chargeCurve: 1.6, // 岩石在飞来途中升温得有多晚
        crackScale: 0.95, // 每单位半径的缝数
        crackWidth: 0.045, // 一条缝张开的宽度（满充能时翻倍）
        crackBranches: 0.5, // 分叉出的更细的缝的强度
        crackGlow: 2.2,
        crackFlow: 0.7, // 岩浆亮度爬动的程度
        crackFlowSpeed: 0.9,
        rockScale: 3.4, // 缝与缝之间岩石的斑驳
        facetTint: 0.5, // 逐个面的明度破碎——这是它读起来像石头的原因
        cavity: 0.25, // 凹坑与切面深处的变暗
        soot: 0.6, // 缝两侧的焦黑
        rimHeat: 0.7, // 轮廓周围的炽热鞘层
        leadGlow: 0.9, // 迎风的面上的压缩热
        leadSharp: 2.6, // 它紧贴前端的紧密程度
        glow: 0.75, // 自发光的总增益
        envIntensity: 1.25, // 岩石捕捉到多少 HDR 探针
        colorRock: '#6e675f',
        colorChar: '#17130f',
        colorCrack: '#ff6a12',
        colorHot: '#fff3d0',

        /* --- 火焰拖尾 --- */
        /**
         * 那道燃烧的尾迹，**以黑体体积做光线步进**——就是自由手势沙盒里
         * 的御火之流，重新瞄准到陨石的弧线上。真正绘制出来的网格
         * 只是一个朝向相机的代理外壳；火焰本身则是在它内部积分出来的，
         * 由 `materials/VolumetricFireMaterial.js` 完成，而那里的四个
         * 层（轮廓 → 涡旋卷起 → 湍流 → 撕裂）正是这些控件所驱动的，
         * 也在那里有解释。
         *
         * 和这里其他一切一样，它不是一段被记录下来的历史：外壳的
         * 中心线直接从弹道上采样，所以这些参数能重塑
         * 已经燃在空中的火。
         *
         * 这个体积借用了岩石的调色板——`colorHot`、`colorFlameMid`、
         * `colorFlameEdge`、`colorFlameSmoke`——但只在
         * `trailPalette` 的比例范围内取用它；为 0 时它是一个纯粹的普朗克辐射体，
         * 颜色则改由 `trailTempCore` / `trailTempEdge` 给出。
         */
        trailSpan: 7.0, // 火在岩石身后覆盖的弧长，米
        trailWidth: 0.66, // 管半径，米
        trailHeadSize: 1.8, // 岩石处火球的半径，× trailWidth
        trailPlume: 1.1, // 体积向上的拉伸（浮力拉长）
        trailWakeSpread: 0.22, // 头部后方废气膨胀的程度
        trailRise: 0.35, // 尾迹远端向上飘起的米数
        // 轮廓上米级的凸瓣。没有它们，无论往上面堆多少细密的湍流，
        // 外形都会一直是个胶囊，拖尾读起来就是一根
        // 加了明暗的管子。
        trailBulge: 0.18, // 这些凸瓣鼓起和收窄局部半径的幅度
        trailBulgeScale: 0.34, // 每米的凸瓣数——更低 = 更大、更慢的形状
        // 从头部脱落、沿尾迹向后行进的环状涡。正是它们
        // 把场折叠成翻卷、蘑菇状的涌浪；单靠 fbm
        // 只能做出云。
        trailVortex: 0.0, // 卷起强度
        trailRingFrequency: 0.0, // 每米流上的涡数
        trailRingSpeed: 4.0, // 它们向后行进的速度
        // 刻意压低：强行让噪声坐标系绕着轴旋转，会把
        // 丝沿周向缠绕起来，火焰就会读成同心等高线，
        // 而不是顺流奔跑的火舌。
        trailCurl: 0.0, // 密度场绕轴的涡旋
        trailTurbulence: 2.94, // 侵蚀体积的噪声振幅
        trailWarp: 0.45, // 域扭曲——把噪声折叠成翻卷的片层
        trailTongue: 0.94, // < 1 把结构向上拉成舔舐的火舌
        trailStreamStretch: 1.13, // < 1 把它们沿流向拉长
        // 径向剪切：外缘相对轴线被向上、向后拖拽的程度。
        // 正是它让边缘结构读起来像舔舐的火舌，
        // 而不是在每个半径上都形状相同的团块。
        trailLick: 3.1,
        trailWisps: 0.81, // 把外缘撕成条缕的脊状细丝
        trailShred: 1.57, // 外缘相对核心被撕裂的猛烈程度
        trailOctaves: 5, // 湍流阶数（质量 ↔ 开销）
        trailSpeed: 4.62, // 场沿路径向后流动的速度
        trailBuoyancy: 3.5, // 它在体积内部上升的速度
        trailDetachment: 0.9, // 尾部撕成独立浮烟团的强度
        trailNoiseStrength: 0.78,
        trailNoiseFrequency: 3.23,
        trailSoftness: 0.42, // 0 = 硬边火舌，1 = 柔和的辉光
        trailFlicker: 0.74,
        trailDensity: 2.09,
        trailSoot: 1.42, // 吸收——冷却的气体遮蔽了多少
        trailCoreClarity: 0.54, // 最热气体中残留的消光（低 = 白色团块）
        trailSteps: 35, // 每像素的光线步进采样数（质量 ↔ 开销）
        trailGlow: 3.06,
        trailOpacity: 0.96,
        trailTailFade: 0.71, // 拖尾中已经烧尽的比例
        trailBurnout: 1.2, // 命中后拖尾熄灭所需的秒数
        // 温度与辐射。火焰按普朗克辐射体着色：这两个值是
        // 它温度范围的两端，以开尔文为单位，而下面那个指数是
        // 所辐射的功率所遵循的。4 就是斯特藩–玻尔兹曼；略柔和一点
        // 能让中间调在这个曝光下不贴地。
        trailTempCore: 1920,
        trailTempEdge: 1590,
        trailEmissionCurve: 4.79,
        trailHeatFocus: 1.54, // 气体在表面之内达到满热的速度
        trailHeatFalloff: 2.46, // 它朝那个表面冷却的陡峭程度
        // 湍流被允许把温度剖面拖动多远。
        // 辐射功率随 T 的高次幂变化，所以这个数字在屏幕上会被
        // 放大好几倍——超过约 0.5 之后，噪声自身的等高线就开始
        // 透出来，形成玛瑙般的条带。
        trailHeatFollow: 0.26,
        trailTailHeat: 0.36, // 尾迹远端废气的温度
        trailPalette: 0.62, // 0 = 纯黑体物理，1 = 下面那些颜色档位
        trailScatter: 1.99, // 火光在烟熏外缘内部的反弹
        trailScatterFalloff: 4.4, // 这份浸染离核心后消退的速度
        colorFlameMid: '#ffb02e',
        colorFlameEdge: '#ff3d10',
        colorFlameSmoke: '#181616',

        /* --- 岩石碎成的碎块 --- */
        chunkCount: 18, // 命中时抛出的碎块数（上限 28）
        chunkScale: 0.28, // 它们的半径，× 陨石的半径
        chunkSpeed: 7.5, // 它们离开山坑的速度，米/秒
        chunkForward: 0.55, // 喷溅偏向射向下游的程度
        chunkLoft: 1.0, // 它们被抛出的陡峭程度
        chunkGravity: -17.0,
        chunkSpin: 6.0, // 翻滚速率，弧度/秒
        chunkCool: 2.6, // 一块碎块的缝熄灭所需的秒数
        chunkLinger: 0.5, // 它们在下沉之前躺在那里的秒数
        chunkSink: 1.0, // 收回地下的秒数

        /* --- 余烬、火花、烟与砂砾 --- */
        /**
         * 与 `ice` 和 `thunder` 中一样：每个系统的着色都来自一条四段渐变，
         * 按粒子自身的生命周期采样，`A` 在诞生时，直到 `D` 消亡时。
         * 这里逐一写出来而不是从火焰调色板推导，这样就能把拖尾
         * 冷却成红色，而岩石自身依旧白热。
         */
        emberRate: 180, // 从岩石上流出的余烬，粒子/秒
        emberSize: 0.1,
        emberSpeed: 2.4,
        emberLifetime: 1.5,
        emberRise: 1.5, // 浮力，米/秒
        emberGlow: 1.2,
        emberTurbulence: 0.5,
        colorEmberA: '#fff3d0',
        colorEmberB: '#ff9a2e',
        colorEmberC: '#ff3b0d',
        colorEmberD: '#2b0d05',
        sparkRate: 110, // 从它身上甩出的火花
        sparkSize: 0.14,
        sparkSpeed: 6.5,
        sparkLifetime: 0.8,
        sparkGravity: -11.0,
        sparkStretch: 0.16, // 一颗火花沿其速度方向拖出的长度
        colorSparkA: '#fffdf2',
        colorSparkB: '#ffd27a',
        colorSparkC: '#ff6a12',
        colorSparkD: '#3d1103',
        smokeRate: 70, // 拖尾以及山坑升起的那道柱
        smokeSize: 1.1,
        smokeSpeed: 1.2,
        smokeLifetime: 3.0,
        smokeOpacity: 0.12,
        smokeRise: 0.9,
        colorSmokeA: '#6b503f',
        colorSmokeB: '#3b2c25',
        colorSmokeC: '#241b17',
        colorSmokeD: '#141010',
        debrisSize: 0.06, // 从地面踢起的砂砾
        debrisSpeed: 6.0,
        debrisLifetime: 1.5,
        debrisGravity: -18.0,
        colorDebrisA: '#3a322c',
        colorDebrisB: '#2a231e',
        colorDebrisC: '#1c1714',
        colorDebrisD: '#151110',

        /* --- 撕裂地面的熔融裂缝 --- */
        /**
         * 真实的几何体，而不是贴花：裂缝的臂从命中处蜿蜒向外，
         * 分出支叉，从白热的核心透出辉光、再穿过一层宽广的橙色
         * 底光，并沿两唇把玄武岩拱起。见
         * `effects/GroundFissures.js`——整个网络烘焙在一个单位圆盘里，所以
         * `fissureRadius` 能重新缩放已经在地面上的裂缝。
         */
        fissureRadius: 5.2, // 裂缝延伸多远，米
        fissureLife: 6.5, // 它们闭合前的秒数
        fissureArms: 6, // 从命中处辐射出的主裂缝数
        fissureWander: 1.6, // 一条臂拐弯的幅度，每单位行程的弧度
        fissureBranches: 0.75, // 生成的支叉被保留的比例，0..1
        fissureBranchLength: 0.85, // 一条支叉延续到它尖端之前走多远，0..1
        fissureWidth: 0.14, // 张开的裂缝的宽度，米
        fissureHeat: 1.5, // 核心温度
        fissurePulse: 1.0, // 沿它们行进的热波速度
        fissureGrowth: 9.0, // 裂缝向外疾冲的速度，米/秒
        fissureRockSize: 0.3, // 沿两唇拱起的玄武岩，米

        /* --- 地面还做了什么 --- */
        scorchRadius: 2.8, // 它下方烧焦的斑块，米
        scorchLife: 8.0,
        scorchIntensity: 0.95,
        shockRadius: 6.0, // 命中冲击波圆环，米
        colorScorch: '#0d0907',
        colorShockA: '#ff9a2e', // 冲击波圆环的主体
        colorShockB: '#fff3d0', // 它的波峰

        /* --- 动态光 --- */
        lightIntensity: 16,
        lightRadius: 14,
        lightColor: '#ff8a3c',
        lightFlicker: 0.25, // 灯光摇曳的深度，0 = 稳定
        lightFlickerSpeed: 13,

        /* --- 发射与起爆 --- */
        muzzleSize: 0.0, // 岩石离开时手部的闪耀——0 = 无
        muzzleIntensity: 1.6,
        castFlash: 0.08, // 释放时的屏幕闪光
        colorCastFlash: '#ff9a2e',
        burstSize: 3.6, // 命中点处的火球，米
        burstIntensity: 1.0,
        burstTurbulence: 2.0, // 噪声侵蚀火球外壳的强度
        burstEmbers: 260, // 命中时额外抛出的余烬
        burstSparks: 180,
        burstDebris: 90,
        burstSmoke: 70,
        impactShake: 1.0,
        shakeDuration: 1.1,
        impactFlash: 0.3,
        rumble: 0.04, // 岩石在空中期间的持续震动
        colorFlash: '#ff9a2e', // 命中时全屏的闪光
    },

    /* ================================================================== */
    /* BEAM —— 能力四                                                     */
    /* ================================================================== */
    /**
     * 一道持续的超光束：施放者在双手中蓄起一个光球，
     * 然后沿瞄准的直线放出一柱光，而这柱光*会停在那里*——
     * 烧进地面 `lifetime` 秒，之后才坍缩回一根细线
     * 并熄灭。外观参考：`superbeam.jpg`。
     *
     * 这是唯一有**第四拍**的能力。冰、雷与陨石都跑
     * 飞行 → 命中 → 消散；光束在那之前加上了一个 `charge`，所以这一击
     * 既是你眼看着它飞来的东西，*也*是落地后持续存在的东西。
     * 为此基类里没有任何地方需要改动——`BeamAbility` 只是
     * 拒绝让前沿在光球蓄满之前离开手部。
     *
     * 这一柱是**一根管子**——见 `assets/ProceduralGeometry.js`——由
     * `materials/BeamMaterial.js` 按三种半径画三遍：一圈宽大的光晕、
     * 一层中空的、按边缘加权的鞘，以及在它内部、权重方式*相反*的
     * 核心，视线越顺着炮管看它越亮。正是这种反转
     * 让中间读起来像一根实心的光棒，而不是一根
     * 被照亮的管子。绕着它盘绕的线圈和沿它疾奔的冲击圆盘是
     * 另外两遍实例化绘制，对的是同一个半径剖面，所以拖动形状时
     * 五者全都焊在一起。
     *
     * 刻意*不*带电：任何地方都没有折角。闪电的噪声是
     * 分段线性的，所以它保留棱角；这里的每一项噪声都是平滑的，
     * 并且沿流向被使劲拉伸，因为会打折的光束就是闪电。
     *
     * 和每一个其他块一样，一次施放除了一个种子和几个
     * 时间戳以外什么也不捕捉。炮管、扩张、线圈螺距和圆盘队列全都在
     * 每帧针对这些数字重新解算——这正是为什么拖动 `radius`
     * 能在时钟停住的情况下，把一道已经在燃烧的光束重新扩膛。
     */
    beam: {
        /* --- 施放 --- */
        range: 26.0, // 最大施放距离，米
        minRange: 3.0, // 比这更近则拒绝施放
        charge: 0.42, // 光球蓄力多少秒后放出光束
        speed: 150.0, // 前缘沿射向疾冲的速度，米/秒
        lifetime: 1.15, // 它落地后燃烧的秒数
        fadeTime: 0.4, // 它坍缩所需的秒数
        cooldown: 1.6,
        castAnim: 'cast1', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 它离开施放者的位置 --- */
        // 双手一起放出的，所以这一个坐在中心线上，而不是
        // 像闪电和岩石那样偏在一侧肩旁。
        handHeight: 1.3, // 距地面的米数
        handForward: 0.72, // 在施放者前方的米数
        handSide: 0.0, // 向侧面的米数（+ 跟随 `Ability#side`）
        endHeight: 1.0, // 光束落点处的高度，米

        /* --- 这一柱 --- */
        // 一个保持收紧的窄喉（`radiusCurve` 大于 1），然后在最后十分之一的
        // 跨度上猛然张开：光束读起来是一道末端带钟口的喷流，
        // 而不是一个锥体，正是这一点把重量放在
        // 命中处，而不是把重量摊在整条线上。
        radiusNear: 0.16, // 出射口处的半宽，米
        radius: 0.77, // 目标处的半宽
        radiusCurve: 1.27, // <1 早早张开，>1 先保持收紧、之后再猛然扩张
        flare: 1.74, // 落点处额外的隆起
        flareWidth: 0.09, // 那处隆起覆盖多少跨度，0..1
        // 两种晃动都出厂为零。这一柱在硬朗、静止的
        // 轮廓下读起来更干净——线圈已经给了眼睛可以跟随的运动——
        // 但下面的速率是调过的，所以抬高其中任何一个只需拖一下。
        throb: 0.0, // 沿它向外行进的压力波
        throbScale: 4.8, // 整段长度上的波数
        throbSpeed: 2.6, // 波/秒
        wander: 0.0, // 轴线漂移的米数，两端被钉住
        wanderScale: 0.9, // 每单位长度的漂移特征数
        wanderSpeed: 0.7,

        /* --- 管子的三遍绘制 --- */
        // 核心刻意做得窄，而且不是完全不透明。把它加宽或把
        // `coreFill` 推高，三层就会叠成一根白色的棒子：青色的
        // 鞘和金色的线圈之所以还能辨认，全靠中间
        // 给它们留了余地。
        coreWidth: 0.2, // 炽热的光棒，× 这一柱的半径
        coreSharp: 1.55, // 核心贴紧轴线的紧密程度
        coreFill: 0.6, // 它读起来有多实
        shellWidth: 1.0, // 那层鞘
        shellRim: 1.15, // 它轮廓边缘的亮度
        shellFill: 0.18, // 它在两者之间有多少实体感
        shellOpacity: 0.95,
        // 又宽又淡：光晕是氛围，不是第二道光束。把它的
        // 不透明度推高会糊掉那层鞘的轮廓边缘，而边缘就是可读性所在。
        haloWidth: 2.75, // 外层辉光
        haloRim: 4.3, // 它紧贴轮廓的紧密程度
        haloOpacity: 0.14,
        edgePower: 2.2, // 那层鞘共用的边缘指数

        /* --- 表面 --- */
        ripple: 0.2, // 噪声把炮管推离正圆的幅度
        rippleBands: 2.2, // 环绕炮管的波纹特征数
        rippleScale: 4.25, // ……以及沿炮管的
        rippleSpeed: 2.0, // 它们朝射向爬行的速度
        streak: 1.1, // 顺流奔跑的丝
        streakSharp: 0.45, // 0 = 一片底色，1 = 硬边细线
        streakScale: 4.2, // 每单位长度的细线数
        streakBands: 1.8, // ……以及环绕炮管的
        // 保持低值：这些细线把热量带进*鞘*里，把它推高
        // 就会发白，直到光束从轴到边缘只剩一种颜色。
        streakGlow: 0.55, // 一根细线在鞘中烧得多热
        flowSpeed: 7.0, // 整个场沿射向流动的速度
        mouthGlow: 1.6, // 这一柱离开光球处的热量
        mouthLength: 0.1, // 它延伸多远，以跨度的比例表示
        // 保持低于出射口的值：扩张和命中外壳已经在支撑
        // 远端，在它们之上再叠一个炽热端帽会把它冲成一片圆盘。
        tipGlow: 0.6, // 前缘 / 燃烧末端上的热量
        tipLength: 0.09, // 该边缘的长度，以跨度的比例表示
        softFade: 0.62, // 它与几何体相交处柔和淡出的米数

        /* --- 颜色 --- */
        colorCore: '#ffffff', // 轴线
        colorInner: '#d3f4ff',
        colorOuter: '#3ec6ff', // 鞘的外侧
        colorHalo: '#0d3ce0', // 环绕它的宽大辉光
        // 这一柱被刻意*压住*。三遍满强度的加法混合管子会
        // 过曝成白色，光束就变成一块平板；把
        // 增益和不透明度降下来能让它保持玻璃感，并把可读性交给线圈。
        glow: 0.74, // 自发光的总增益
        opacity: 0.29,

        /* --- 线圈 --- */
        /**
         * 绕着这一柱盘旋的带条，用的就是画闪电的那条带状条。
         * 刻意取暖色：参考图给一道白热的光束配了金色
         * 线圈，而正是这种颜色上的分离阻止它们溶进鞘里。
         */
        coils: 4, // 带条数（上限 8）
        coilTurns: 1.45, // 每一条在整段长度上绕的圈数
        // 负值，所以这些带条朝充能脉冲奔跑的方向*反向*
        // 翻滚。两种运动读起来不同，才不会让一道持续中的光束
        // 看起来像一根旋转的螺丝。
        coilSpeed: -0.69, // 在那之上它们翻滚的速度，圈/秒
        coilRadius: 1.88, // 它们骑在多外面，× 这一柱的半径
        coilFlare: 0.57, // 远端的额外张开
        coilWidth: 0.1, // 出射口处的半宽，米
        coilWidthTip: 1.9, // 该宽度在目标处的倍数
        coilSharp: 2.2, // 带条横跨宽度衰减的强度
        coilPulse: 0.65, // 沿它奔跑的充能的深度
        coilPulseFreq: 3.0, // 整段长度上的脉冲数
        coilPulseSpeed: 1.6, // 脉冲/秒
        // 刻意驱动得很强。上面的那一柱被压下来之后，
        // 眼睛真正顺着光束跟随的正是这些带条。
        coilGlow: 8.0,
        coilOpacity: 2.0,
        colorCoil: '#ffdc8c',
        colorCoilEdge: '#ff6a12',

        /* --- 冲击圆盘 --- */
        rings: 10, // 飞行中的圆盘数（上限 12）
        ringSpeed: 1.31, // 每秒沿光束走完的趟数
        // 两侧边唇都离鞘很远，而且彼此靠得很近：圆盘读起来是
        // 环绕这一柱的细箍，而不是从它身上长出来的板。
        ringInner: 2.42, // 内侧边唇，× 局部柱半径
        ringOuter: 2.73, // 外侧边唇
        ringSwell: 0.55, // 它们行进时张开的程度
        ringFade: 0.18, // 一个圆盘落地时还剩下多少
        ringSharp: 1.6, // 这条带读起来有多细
        ringGlow: 2.4,
        ringOpacity: 0.7,
        colorRing: '#9ceeff',

        /* --- 蓄能光球 --- */
        orbSize: 0.39, // 蓄满能量时的半径，米
        orbThrob: 0.11, // 它搏动的强度
        orbThrobSpeed: 6.9,
        orbTurbulence: 0.24, // 噪声侵蚀它表面的程度
        orbScale: 2.2, // 表面的特征数
        orbFlow: 0.9, // 它们爬动的速度
        orbBands: 5.0, // 丝的频率
        orbRim: 1.8, // 边缘指数
        orbGlow: 2.8,
        orbOpacity: 1.0,

        /* --- 地面做了什么 --- */
        scorchRate: 1.1, // 前沿每行进一米铺设的灼痕数
        scorchRadius: 0.7, // 一道的半径，米
        scorchLife: 7.0, // 它滞留的秒数
        scorchIntensity: 0.55,
        colorScorch: '#0a0d14',
        colorEmber: '#4ad6ff',
        dustRate: 7.0, // 燃烧末端抛出的尘环，每秒
        dustRadius: 2.4, // 一道尘环的半径，米
        dustLife: 0.9,
        colorDustA: '#3d5c74',
        colorDustB: '#9ceeff',
        shockRate: 3.5, // 在地面上弹开的压力环，每秒
        shockRadius: 7.0, // 命中处那一个的半径，米
        colorShockA: '#3ec6ff', // 冲击波圆环的主体
        colorShockB: '#ffffff', // 它的波峰

        /* --- 火花、微尘、烟与碎屑 --- */
        /**
         * 与 `ice`、`thunder` 和 `meteor` 中一样：每个系统的着色都来自一条
         * 四段渐变，按粒子自身的生命周期采样，`A` 在诞生时，直到 `D` 消亡时。
         * 这些微尘身兼两职——它们既是蓄能时螺旋*进入*
         * 光球的吸入流，也是光束开火后从这一柱上散落的
         * 飘浮物。
         */
        sparkRate: 300, // 从这一柱上散落的火花，粒子/秒
        sparkSize: 0.15,
        sparkSpeed: 8.0,
        sparkLifetime: 0.55,
        sparkGravity: -9.0,
        sparkStretch: 0.22, // 一颗火花沿其速度方向拖出的长度
        sparkForward: 0.9, // 这份喷溅被拖向射向下游的强度
        colorSparkA: '#ffffff',
        colorSparkB: '#d3f4ff',
        colorSparkC: '#3ec6ff',
        colorSparkD: '#0b2f7a',
        moteRate: 120, // 悬浮在这一柱周围的飘浮物
        moteSize: 0.06,
        moteSpeed: 1.6,
        moteLifetime: 1.5,
        moteRise: 0.9, // 向上漂移，米/秒
        moteTurbulence: 0.8,
        colorMoteA: '#ffffff',
        colorMoteB: '#9ceeff',
        colorMoteC: '#3ec6ff',
        colorMoteD: '#06205e',
        intakeRate: 260, // 蓄能时被拉进光球的微尘
        intakeRadius: 2.6, // 它们从多远处被吸引过来，米
        intakeSpeed: 7.5, // 它们落入的速度
        smokeRate: 90, // 从光束下方地面刷起的蒸汽
        smokeSize: 1.1,
        smokeSpeed: 1.4,
        smokeLifetime: 2.4,
        smokeOpacity: 0.07,
        smokeRise: 0.7,
        colorSmokeA: '#41566d',
        colorSmokeB: '#35485e',
        colorSmokeC: '#2a3949',
        colorSmokeD: '#1a2430',
        debrisRate: 34, // 沿燃烧线从地面撕下的碎屑
        debrisSize: 0.06,
        debrisSpeed: 6.0,
        debrisLifetime: 1.4,
        debrisGravity: -18.0,
        colorDebrisA: '#2b323c',
        colorDebrisB: '#1f252d',
        colorDebrisC: '#1a1f26',
        colorDebrisD: '#1a1f26',

        /* --- 动态光 --- */
        // 两盏灯：一盏骑在光束上，一盏待在施放者手中，这样
        // 蓄能就真的会照亮捧着它的那具身体。
        lightIntensity: 30,
        lightRadius: 20,
        lightColor: '#7fdcff',
        lightPulse: 0.18, // 嗡鸣的深度，0 = 稳定
        lightPulseSpeed: 5.0, // 脉冲/秒
        muzzleLightIntensity: 16,
        muzzleLightRadius: 9,

        /* --- 蓄力、释放与燃烧 --- */
        chargeShake: 0.045, // 光球蓄力期间的震动
        castFlash: 0.22, // 它被释放时的屏幕闪光
        muzzleSize: 1.1, // 从双手抛出的压力外壳，米
        muzzleIntensity: 2.0,
        colorCastFlash: '#d3f4ff',
        burstSize: 4.2, // 命中点处的外壳，米
        burstIntensity: 1.6,
        burstSparks: 220, // 它落地时额外抛出的火花
        burstDebris: 70,
        pulseRate: 2.6, // 从燃烧末端脱落的压力外壳，每秒
        pulseSize: 2.2, // 一个的半径，米
        pulseIntensity: 1.1,
        splashRate: 260, // 燃烧期间沿光束反踢回来的火花
        impactShake: 0.9,
        shakeDuration: 0.7,
        burnShake: 0.09, // 光束存在期间的持续震动
        impactFlash: 0.3,
        rumble: 0.05, // 前缘行进期间的震动
        colorBurstA: '#3ec6ff',
        colorBurstB: '#d3f4ff',
        colorBurstC: '#ffffff',
        colorFlash: '#d3f4ff', // 命中时全屏的闪光
    },

    /* ================================================================== */
    /* SNARE —— 能力五，也是第一个**远距施放**                            */
    /* ================================================================== */
    /**
     * 一个布设在某一点上的陷阱，而不是沿一条线发射出去的一击：施放者
     * 甩出一条电流之索越过地面，在它落地之处圆环
     * 猛然张开——一柱闪电从中央撕开地面涌出，卷须
     * 向外爬到边界，弧光绕着环边奔跑，这一切
     * 会维持、反复重击、把空气向上拖拽 `lifetime` 秒，然后
     * 坍缩。外观参考：`electricalboost.jpg`。
     *
     * 正是这个块定义了本项目里远距施放*是什么*。
     * 瞄准的是一个圆（见 `zone` 块），而 `zoneRadius` 是这个圆
     * 做出的承诺：指示器画出的边界，就是场烧出的边界、
     * 卷须够到的边界、环边弧光奔跑的边界，所以拖动
     * 这一个数字，就能同时重新缩放指示器和一道已经立起来的
     * 陷阱。
     *
     * 整个笼子是**一条实例化的带状条**——见 `materials/SnareMaterial.js`。
     * 每一根丝都是同一条带条，而由它的实例索引决定的
     * *角色*（索 → 柱 → 卷须 → 环边）挑出顶点着色器
     * 把它沿着哪条参数化路径穿起来。不管空中有多少根丝，
     * 这四种角色一共只用两次绘制调用。
     *
     * 和每一个其他块一样，一次施放除了一个种子和几个
     * 时间戳以外什么也不捕捉。每一米、每一弧度、每一秒都在每帧
     * 针对这些数字重新解算——包括一个长度为零的施放，这正是为什么陷阱
     * 能在时钟停住的情况下随滑块重塑。
     */
    snare: {
        /* --- 施放 --- */
        range: 20.0, // 最大施放距离，米
        minRange: 0.0, // 陷阱完全可以合法地丢在自己脚下
        zoneRadius: 4.4, // 落点范围——圆形指示器量出的东西
        speed: 62.0, // 索奔向该点的速度，米/秒
        snapTime: 0.16, // 它落地后圆环猛然张开所需的秒数
        lifetime: 2.6, // 陷阱站立的秒数
        fadeTime: 0.75, // 它坍缩所需的秒数
        cooldown: 1.4,
        castAnim: 'cast2', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 种下它的那条索 --- */
        // 从手中掷出，所以这些值是在施放自身的坐标系里、从施放者原点
        // 量起的，和闪电、岩石完全一样。
        handHeight: 1.24, // 距地面的米数
        handForward: 0.58, // 在施放者前方的米数
        handSide: 0.18, // 向侧面的米数（+ 跟随 `Ability#side`）
        leashStrands: 3, // 这条鞭里的丝数
        leashSag: -0.35, // 中段弓起的米数（负值让它垂到地面）
        leashSpread: 0.22, // 这些丝彼此分开的米数
        leashKink: 0.3, // 这条鞭上的折角振幅，米
        leashWidth: 1.0, // × 共用的丝宽
        leashCling: 0.12, // 尖端离地面多高，米

        /* --- 这一柱 --- */
        strands: 15, // 这根柱里的丝数
        height: 9.2, // 它够到多高，米
        heightCurve: 1.45, // <1 让它很快升上去，>1 让它后段才爬升
        throat: 0.16, // 它离开地面处的半径，× zoneRadius
        columnSpread: 0.25, // 顶部的半径，× zoneRadius
        columnCurve: 2.88, // >1 保持喉部收紧、之后再张开
        columnFlare: 0.585, // 最后四分之一上的额外张开，× zoneRadius
        columnTwist: 0.22, // 一根丝在爬升过程中绕的圈数
        columnSpin: 1.26, // 整根柱翻滚的速度，圈/秒
        columnKink: 0.27, // 折角振幅，米
        columnWidth: 1.86, // × 共用的丝宽
        columnTaper: 1.09, // 顶部比底部细多少

        /* --- 向外爬到边界的卷须 --- */
        tendrils: 20, // 彼此分开的地面丝（连同其余部分合计上限 56）
        tendrilInner: 0.0, // 它们离开柱子的位置，× zoneRadius
        tendrilReach: 1.07, // 它们结束的位置，× zoneRadius（1 = 正好落在边带上）
        tendrilCurve: 1.18, // <1 让它们早早向外甩出
        tendrilWander: 1.41, // 一根卷须在行程中拐弯的弧度
        tendrilArch: 1.16, // 它在中段跳离地面的米数
        tendrilHug: 0.005, // 它离地面多高，米
        tendrilSpin: -0.225, // 整个扇形旋转的速度，圈/秒
        tendrilKink: 0.72, // 折角振幅，米
        tendrilWidth: 0.75, // × 共用的丝宽
        tendrilDim: 0.8, // 比柱子暗多少

        /* --- 绕着环边奔跑的弧光 --- */
        rimArcs: 14, // 同时出现在边界上的弧数
        rimSpan: 0.335, // 一段弧覆盖整个圆的比例
        rimSpeed: -1.84, // 它们行进的速度，转/秒
        // 高到足以越过它们下方烧焦的边带：在一圈这么亮的
        // 边带上方只跳 0.3 米的弧，根本看不见。
        rimHeight: 0.98, // 它们在中段跳起的米数
        rimJitter: 0.23, // 径向摆动，× zoneRadius
        rimKink: 0.15, // 折角振幅，米
        rimWidth: 0.85, // × 共用的丝宽
        rimDim: 1.0,

        /* --- 每根丝共有的形状 --- */
        // 与闪电所用的分段线性值噪声相同——刻意用线性，
        // 因为 smoothstep 会把棱角磨圆，而棱角正是
        // 它读起来像闪电的全部原因。
        jitter: 1.0, // 四个逐角色折角振幅的总乘数
        jitterScale: 1.4, // 每米的折角数
        octaves: 4, // 1–5；每一阶把振幅减半、频率加倍
        jitterFalloff: 0.55, // 每一阶保留的振幅
        crawl: 2.4, // 折角沿一根丝滑动的速度
        pinch: 0.16, // 两端被拉直的那一段占整个跨度的比例
        restrike: 21, // 每根丝每秒重掷形状的次数
        flicker: 0.26, // 整个笼子亮度抖动的深度
        flickerSpeed: 30,
        strandFlash: 0.45, // 单根丝熄灭的程度

        /* --- 带状条 --- */
        width: 0.032, // 一根丝的半宽，米
        coreSharp: 4.4, // 炽热核心在带状条上衰减的强度
        glowWidth: 6.2, // 光晕，× 核心宽度
        glowFalloff: 2.3, // 光晕在它自己的带状条上淡出的速度
        glowOpacity: 0.44,
        softFade: 0.7, // 一根丝与几何体相交处柔和淡出的米数

        /* --- 颜色 --- */
        // 用紫色而不是风暴之枪的蓝色：技能栏上两个电系能力
        // 需要一眼就能分辨，而色调的区分比轮廓
        // 更早做到这一点。
        colorCore: '#ffffff', // 一根丝的中心
        colorInner: '#dcd0ff',
        colorOuter: '#8f6bff', // 一根丝的外侧
        colorHalo: '#2a0e8c', // 环绕笼子的宽大辉光
        glow: 2.2, // 自发光的总增益
        opacity: 1.0,

        /* --- 烧进地面的场 --- */
        /**
         * 指示器的承诺被兑现了：同一个圆、同样加粗的
         * 边界，如今是一个实时的着色器，而不再是一个瞄准辅助。它之所以是
         * 能力自有的网格而不是贴花，正是因为贴花会在生成时锁住
         * 自己的半径——而这一个必须在站立期间随 `zoneRadius`
         * 重新缩放。
         */
        fieldBoundary: 0.02, // 烧焦边带的厚度，米
        fieldBoundaryGlow: 2.9,
        fieldFill: 0.65, // 它内部的底色填充
        fieldFalloff: 3.6, // 那份填充挤向边缘的强度
        fieldVeins: 2.98, // 烧遍整个圆盘的丝
        fieldVeinScale: 2.0, // 每米的脉纹数
        fieldVeinSharp: 0.72, // 0 = 一片底色，1 = 硬边细线
        fieldWarp: 0.55, // 域扭曲——阻止这些脉纹读成辐条的东西
        fieldCrawl: 0.5, // 它们扭动的速度
        fieldRings: 2.4, // 从中间向外行进的压力环
        fieldRingSpeed: 0.8, // 环/秒
        fieldSpokes: 20, // 沿边界一圈排布的刻度
        fieldSpokeLength: 0.5, // 它们向内延伸的距离，米
        fieldSpin: 0.05, // 这些刻度绕行一圈的速度，转/秒
        fieldCore: 1.3, // 柱子所立的那片光池的亮度
        fieldCoreSize: 0.22, // 它的半径，× zoneRadius
        fieldPulse: 0.0, // 亮度的呼吸起伏
        fieldPulseSpeed: 3.95,
        fieldOpacity: 1.0,
        fieldHeight: 0.03, // 悬浮于地面之上的距离，米
        colorField: '#8f6bff', // 底色填充与脉纹
        colorFieldEdge: '#ffffff', // 边界带与核心光池

        /* --- 地面还做了什么 --- */
        arcRate: 5.0, // 绕环边铺设的分叉灼痕，每秒
        arcRadius: 1.2, // 一道的半径，米
        arcLife: 0.75,
        arcIntensity: 0.9,
        arcBranches: 0.7, // 一道灼痕分裂成细丝的精细程度
        trailRate: 1.1, // 索疾冲出去时每米铺设的灼痕数
        scorchRadius: 1.6, // 柱子下方的深色灼烧，米
        scorchLife: 7.5,
        scorchIntensity: 0.5,
        colorArc: '#c3b0ff',
        colorEmber: '#8f6bff',
        colorScorch: '#0b0813',
        shockRadius: 7.0, // 陷阱张开时猛然弹出的圆环，米
        colorShockA: '#8f6bff', // 冲击波圆环的主体
        colorShockB: '#ffffff', // 它的波峰

        /* --- 火花、上升气流、烟与碎屑 --- */
        /**
         * 与其他每一个块一样：一条四段渐变，按粒子自身的
         * 生命周期采样，`A` 在诞生时，直到 `D` 消亡时。**上升气流**是这个
         * 能力的招牌系统——从整个圆盘上抽出的微尘被拉向内侧、
         * 拽进柱中，这正是让陷阱读起来像在拉扯空气
         * 而不只是待在空气里的那一笔。
         */
        sparkRate: 320, // 从笼子上抛出的火花，粒子/秒
        sparkSize: 0.15,
        sparkSpeed: 8.5,
        sparkLifetime: 0.55,
        sparkGravity: -13.0,
        sparkStretch: 0.2, // 一颗火花沿其速度方向拖出的长度
        colorSparkA: '#ffffff',
        colorSparkB: '#dcd0ff',
        colorSparkC: '#8f6bff',
        colorSparkD: '#2a0e8c',
        updraftRate: 210, // 被拽上柱子的微尘，粒子/秒
        updraftSize: 0.07,
        updraftSpeed: 6.0, // 它们被拉进来的速度
        updraftLifetime: 1.4,
        updraftRise: 5.5, // 它们进入之后的向上加速度，米/秒²
        updraftInset: 0.15, // 它们在边界内侧多远处被拾起
        updraftTurbulence: 0.9,
        colorUpdraftA: '#8f6bff',
        colorUpdraftB: '#dcd0ff',
        colorUpdraftC: '#ffffff',
        colorUpdraftD: '#1b0a5e',
        smokeRate: 70, // 从烧焦的地面上刷起的薄雾
        smokeSize: 1.05,
        smokeSpeed: 1.2,
        smokeLifetime: 2.4,
        smokeOpacity: 0.06,
        smokeRise: 0.6,
        colorSmokeA: '#4a4368',
        colorSmokeB: '#3a3554',
        colorSmokeC: '#2b2740',
        colorSmokeD: '#191728',
        debrisRate: 30, // 从圆环内的地面撕下的碎屑
        debrisSize: 0.055,
        debrisSpeed: 5.5,
        debrisLifetime: 1.3,
        debrisGravity: -17.0,
        colorDebrisA: '#2a2733',
        colorDebrisB: '#201e28',
        colorDebrisC: '#1a1822',
        colorDebrisD: '#1a1822',

        /* --- 动态光 --- */
        lightIntensity: 24,
        lightRadius: 18,
        lightHeight: 0.38, // 灯光位于柱子的多高处，0..1
        lightColor: '#a98bff',
        lightFlicker: 0.38, // 灯光摇曳的深度，0 = 稳定
        lightFlickerSpeed: 24,

        /* --- 抛出、弹开与维持 --- */
        muzzleSize: 0.5, // 索离开时手部的闪光
        muzzleIntensity: 1.7,
        castFlash: 0.09, // 释放时的屏幕闪光
        colorCastFlash: '#c3b0ff',
        burstSize: 2.8, // 圆环张开时抛出的外壳，米
        burstIntensity: 1.5,
        burstSparks: 200, // 弹开时额外的火花
        burstDebris: 60,
        pulseRate: 1.5, // 维持期间从柱子上脱落的外壳，/秒
        pulseSize: 1.2, // 一个的半径，米
        pulseIntensity: 0.5,
        ringRate: 1.4, // 维持期间推过地面的尘环，/秒
        impactShake: 0.85,
        shakeDuration: 0.6,
        holdShake: 0.07, // 陷阱站立期间的持续震动
        impactFlash: 0.26,
        rumble: 0.025, // 索疾冲出去时的震动
        colorBurstA: '#8f6bff',
        colorBurstB: '#dcd0ff',
        colorBurstC: '#ffffff',
        colorFlash: '#c3b0ff', // 它弹开时全屏的闪光
    },

    /* ================================================================== */
    /* GLACIER —— 能力六，也是从地面里长出来的那个远距施放                */
    /* ================================================================== */
    /**
     * 一道寒潮沿地面疾冲到瞄准点，圆盘一直冻结到
     * 那个圆画出的边界，一圈水晶墙从它周围的地面
     * 撕开涌出：一环向外倾斜的冰刃，脚下还垒着一圈
     * 残骸裙带。它站立、闪烁、从边缘散出寒气——
     * 然后碎成板块、沉回地面。外观参考：
     * `Hud7Xfg3LH.jpg`。
     *
     * **中间保持空着**：每一块碎片都坐落在 `zoneRadius` 附近的一条
     * 带上，中心什么都不种，因为它的可读性是一面你往里
     * 看的墙，把圆盘填满就不再是一个环了。它内部
     * 存在的是空气和冻住的地面。
     *
     * 第二个**远距施放**，也是 Voltaic Snare 的对应物：同样的
     * 圆、同样的承诺、相反的答案。陷阱把落点范围填满
     * 悬在空中的电流；这一个把它填满立在地面上的
     * 几何体，所以 `zoneRadius` 又一次成为唯一重要的数字——它是
     * 冰刃之环坐落之处、是冰面的边界带烧灼之处、是
     * 寒气的帷幕站立之处，也是白霜蔓延之处。
     *
     * 三样东西支撑着它，每一样在下面都有自己的组：
     *
     *  - **扫掠。** 这个环不是浮现出来的；它是*合拢*的。最靠近
     *    施放者的那一片冰刃先升起，波沿两侧奔跑，在冠的后方
     *    会合（`sweepTime`），裙带则在波的后方垒起
     *    （`skirtDelay`、`skirtWave`）。
     *  - **冻结前沿。** 每一块碎片在上升时都沿自己的轴
     *    向上结晶（`frontRough`、`frontWidth`、`frontGlow`——见
     *    `materials/GlacierMaterial.js`），所以冰是*成形*的，而不是从
     *    一个洞里滑出来。
     *  - **碎裂。** 它离去的方式和到来的方式一样，都是成片的：
     *    一个逐碎片的斜坡，对着由 voronoi 单元和平面小面组成的
     *    碎块 id，所以板块和楔形一块一块地脱落（`shatterScale`、
     *    `shatterEdge`、`shatterGlow`）。
     *
     * 和每一个其他块一样，一次施放除了一个种子和几个
     * 时间戳以外什么也不捕捉。每一米、每一弧度、每一秒都在每帧
     * 针对这些数字重新解算——包括一个长度为零的施放，这正是为什么冠
     * 能在时钟停住的情况下随滑块重塑。
     */
    glacier: {
        /* --- 施放 --- */
        range: 18.0, // 最大施放距离，米
        minRange: 0.0, // 在自己脚下围一圈冰墙是完全正当的打法
        zoneRadius: 4.6, // 落点范围——圆形指示器量出的东西
        speed: 44.0, // 前沿疾冲到该点的速度，米/秒
        snapTime: 0.22, // 冰面冻结到边界所需的秒数
        lifetime: 4.2, // 冠站立的秒数
        shatterDelay: 0.5, // `lifetime` 之后再过多少秒冰开始碎裂
        shatterStagger: 0.45, // 相邻个体之间随机延迟的秒数
        sinkTime: 1.15, // 一块碎片崩解并收回所需的秒数
        cooldown: 1.6,
        castAnim: 'cast3', // 身体抛出 `CAST_ANIMATIONS` 中的哪个剪辑

        /* --- 前沿离开施放者的位置 --- */
        // 从手中掷出，所以这些值是在施放自身的坐标系里、从施放者原点
        // 量起的，和闪电、岩石、索完全一样。
        handHeight: 1.22, // 距地面的米数
        handForward: 0.6, // 在施放者前方的米数
        handSide: 0.18, // 向侧面的米数（+ 跟随 `Ability#side`）

        /* --- 落点范围如何被填满 --- */
        /**
         * 一切都坐落在 `zoneRadius` 附近的一条带上；圆的中间
         * 是刻意留空的，因为这个能力的可读性是一面你往里*看*的
         * 墙，把圆盘填满就不再是一个环了。中间的那座尖塔
         * 保留下来作为一个控件，出厂值为零。
         */
        spikeCount: 220, // 一次施放消耗的实例数（上限 320）
        density: 1.0, // 该数量的乘数
        ringShare: 0.6, // 其中用在边界那面墙上的比例
        coreShare: 0.0, // ……用在中间的尖塔上（0 = 中间保持空着）
        lateShare: 0.12, // ……留到维持阶段才推上来
        ringSeat: 0.94, // 墙站立的位置，× zoneRadius
        ringScatter: 0.16, // 墙的径向抖动，× zoneRadius
        skirtSeat: 0.74, // 垒在它脚下的残骸的内侧边唇，× zoneRadius
        skirtBand: 0.42, // 那条带有多宽，× zoneRadius
        skirtBias: 0.9, // <1 把裙带向外推，>1 把它向内挤
        coreSpread: 0.16, // 中间那一簇的半径，× zoneRadius

        /* --- 轮廓 --- */
        /**
         * 参考图是一记*星芒*，而不是一道栅栏：长针以陡峭的角度
         * 从边缘向外抛出，偏离半径呈扇形展开、彼此交叉，
         * 长度参差得厉害。`ringLean` 是决定它读起来像一个冠
         * 还是一排木桩的唯一控件——为 0 时它是一道栅栏，
         * 值越高，冰刃就被抛得越远、越铺展在地面上。
         */
        ringHeight: 1.4, // 墙上冰刃的长度，米
        ringWave: 0.61, // 那面墙的顶沿有多不均齐，0..1
        skirtHeight: 1.7, // 裙带里一块碎片的长度，米
        coreHeight: 5.2, // 尖塔的长度，米
        heightJitter: 0.65,
        ringLean: 0.33, // 墙向外抛出的弧度（≈19°）
        skirtLean: 0.3, // ……以及裙带
        coreLean: 0.2, // 尖塔几乎直立
        leanJitter: 1.3,
        fan: 1.16, // 一片冰刃偏离自身半径的弧度，±——就是那处交叉
        twist: 1.0, // 随机偏航，以整圈的比例表示，0..1
        rubble: 0.53, // 降级为脚踝高残骸的裙带比例
        rubbleScale: 0.34,

        /* --- 单个水晶 --- */
        // 是钝楔而不是细针：粗厚的底部到尖端只收细到大约
        // 三分之一，这样每个面都还够宽，能接住一次闪光。
        radius: 0.375, // 底部半径，米
        radiusJitter: 0.94,
        taper: 0.36, // 尖端半径占底部的比例
        facets: 7, // 棱柱的侧面数——更少，这样每个面都是一次宽大的闪光
        roughness: 0.0, // 各个面相对干净棱柱被推离的程度
        bend: 0.0, // 从底部到尖端的侧向弯曲——几乎笔直

        /* --- 绽放：每块碎片何时升起 --- */
        riseTime: 0.2, // 从埋在地下到全高所需的秒数
        riseOvershoot: 0.3, // 这一记冲击越过全高的幅度
        settle: 0.5, // 过冲阻尼掉所需的秒数
        sweepTime: 0.42, // 这道波绕环跑一圈所需的秒数
        skirtDelay: 0.1, // 裙带开始之前的秒数
        skirtWave: 0.26, // ……以及它穿过那条带需要多久
        coreDelay: 0.2, // 尖塔升起之前的秒数
        stagger: 0.07, // 在这之上再叠加的随机延迟秒数
        bloomSpread: 0.7, // 后到的碎片散布在维持阶段的多大比例上

        /* --- 冰：棱镜般的玻璃，而不是长枪那种采掘出的水晶 --- */
        /**
         * 刻意采用与 `ice` *相反*的处理。技能栏上两个霜冻能力
         * 必须在轮廓之前就能分辨，而重新上色不够——所以
         * 霜之长枪是乳白、漫射、越厚色调越深的，而这些冰刃则是
         * 近乎空心的玻璃，完全由它们的边缘支撑起来：一个色散
         * 分离的菲涅尔（`dispersion`）、沿刃体一路导管到白炽点
         * 的光（`pipe`、`tipBias`、`tipGlow`）、流动的线纹
         * 而不是羽状霜（`stria`），以及每个面对舞台的一次
         * 真实反射（`envIntensity`、`specular`）。
         * 见 `materials/GlacierMaterial.js`。
         */
        colorGlass: '#0e4a66', // 它仅有的一点体量
        colorEdge: '#ffffff', // 轮廓、流动线纹与闪光点
        colorPrismA: '#57f0ff', // 色散分离的一端
        colorPrismB: '#8f9bff', // ……以及另一端
        colorCore: '#a8f4ff', // 沿冰刃导管上来的光
        colorTip: '#ffffff', // 白炽的尖端
        body: 1.37, // 它究竟有多少体量，0 = 纯边缘
        edgePower: 1.14, // 轮廓紧贴边缘的紧密程度
        edgeGain: 0.81, // 它燃烧的强度
        dispersion: 0.73, // 红、绿、蓝三次菲涅尔彼此分开的距离
        pipe: 1.09, // 沿冰刃导管的光
        tipBias: 1.6, // 那道光向尖端聚集的强度
        bands: 1.4, // 沿它向上行进的缓慢波
        pulseSpeed: 0.6,
        tipStart: 0.6, // 白炽尖端从何处开始，以冰刃高度的 0..1 表示
        tipGlow: 1.5,
        stria: 0.75, // 贯穿冰刃长度的流动线纹
        striaScale: 6.0,
        envIntensity: 0.6, // 各个面捕捉到多少 HDR 探针
        specular: 2.0, // 从它们身上反射出的紧致太阳高光瓣
        glow: 1.0, // 自发光的总增益
        opacity: 1.0,
        birthGlow: 2.2, // 刚刚喷出的碎片上额外的辉光
        birthFade: 0.5, // 那次诞生闪光持续的秒数

        /* --- 冻结前沿与碎裂 --- */
        /**
         * 正是这两样东西让这个能力的冰*到来*和*离去*，而不是
         * 淡入淡出。两者都是能力驱动的逐实例斜坡；住在这里的
         * 只是它们的外观。
         */
        frontRough: 0.35, // 结晶边缘有多参差不齐
        frontWidth: 0.12, // 该边缘之后有多少碎片被点亮
        frontGlow: 2.4, // 它燃烧的强度
        shatterScale: 7.0, // 水晶每单位上的破碎单元数
        shatterEdge: 0.08, // 新断口上被点亮的边缘宽度
        shatterGlow: 3.0,

        /* --- 地面上的那层冰 --- */
        /**
         * 指示器的承诺被兑现了：同一个圆、同样加粗的边界，
         * 如今是一层冻住的冰面，而不再是一个瞄准辅助。它之所以是
         * 能力自有的网格而不是贴花，正是因为贴花会在生成时锁住
         * 自己的半径——而这一个必须在冠站立期间随 `zoneRadius`
         * 重新缩放，并且要让自己的前沿向外跑出去、再收回来。
         */
        fieldBoundary: 0.4, // 边缘那条带的厚度，米
        fieldBoundaryGlow: 2.4,
        fieldFill: 0.26, // 它内部的底色填充
        fieldFalloff: 1.4, // 那份填充挤向边缘的强度
        fieldPlates: 1.0, // 板块之间的明度破碎
        fieldPlateScale: 2.2, // 每米的板块数
        fieldSeam: 0.8, // 堆在它们之间缝隙里的白霜
        fieldFingers: 0.9, // 在冰面上爬行的霜指
        fieldFingerScale: 1.6, // 每米的霜指数
        fieldWarp: 0.5, // 域扭曲——阻止它们读成辐条的东西
        fieldCrawl: 0.12, // 它们扭动的速度
        fieldRings: 2.6, // 朝尖塔向内行进的压力环
        fieldRingSpeed: -0.5, // 环/秒（负值向内行进）
        fieldSweep: 0.4, // 绕圆盘缓慢扫过的寒气
        fieldSweepSpeed: 0.12, // 转/秒
        fieldCore: 1.0, // 尖塔所立的那片光池的亮度
        fieldCoreSize: 0.2, // 它的半径，× zoneRadius
        fieldPulse: 0.18, // 亮度的呼吸起伏
        fieldPulseSpeed: 1.6,
        fieldOpacity: 1.0,
        fieldHeight: 0.03, // 悬浮于地面之上的距离，米
        colorField: '#a7e6ff', // 底色填充、板块与霜指
        colorFieldEdge: '#ffffff', // 边界带、缝隙与光池

        /* --- 立在环上的寒气帷幕 --- */
        /**
         * 一个坐在边界上的开口圆柱，被沿垂直方向使劲拉伸、向下滚动的
         * 脊状噪声侵蚀。正是这一块从外面把冠
         * 框起来：没有它，冰刃之墙就止于它自己的
         * 轮廓，而一面不再散出寒气的冰墙读起来就是玻璃。
         * 把 `veil` 设为 0 可以把它取下来。
         */
        veil: 0.5, // 帷幕的总不透明度，0 表示隐藏
        veilHeight: 1.9, // 它站立的高度，米
        veilRadius: 1.02, // 它站立的位置，× zoneRadius
        veilFlare: 0.32, // 它在顶部向外倾斜的程度
        veilBillow: 0.22, // 把它的轮廓推离正圆的米级凸瓣
        veilScale: 1.4, // 每米的噪声特征数
        veilStretch: 0.5, // <1 把结构拉成垂直的瀑布
        veilFlow: 0.4, // 它们向下倾泻的速度
        veilErode: 0.55, // 顶部比底部被侵蚀得多厉害
        veilFalloff: 1.8, // 它随高度变薄的速度
        veilSpin: 0.02, // 整幅帷幕旋转的速度，转/秒
        veilSoftFade: 0.8, // 它与几何体相交处柔和淡出的米数
        colorVeil: '#8cd2ff',
        colorVeilCrest: '#ffffff',

        /* --- 地面做了什么 --- */
        trailFrostRate: 2.2, // 前沿每行进一米铺设的白霜斑块数
        trailFrostRadius: 1.0, // 一个斑块的半径，米
        frostSpread: 1.5, // 冠下方的白霜覆盖面，× zoneRadius
        frostLife: 7.5, // 一个白霜斑块滞留的秒数
        frostIntensity: 0.85,
        frostCrystals: 1.5, // 压实的雪的颗粒感
        frostCollar: 2.6, // 一片冰刃脚边的白霜，× 它自身的半径
        rimeRate: 3.0, // 沿边界缓慢蔓延的白霜斑块，每秒
        rimeRadius: 1.0, // 一个斑块的半径，米
        colorFrost: '#f0f9ff', // 雪受光的一面
        colorFrostEdge: '#79b6dd', // 它在自身阴影中变成的颜色
        shockRadius: 7.5, // 冠绽放时猛然弹出的圆环，米
        ringRate: 0.9, // 它站立期间推出的压力环，每秒
        colorShockA: '#8ee8ff', // 冲击波圆环的主体
        colorShockB: '#ffffff', // 它的波峰

        /* --- 雾、碎屑、闪光与雪 --- */
        /**
         * 与其他每一个块一样：一条四段渐变，按粒子自身的
         * 生命周期采样，`A` 在诞生时，直到 `D` 消亡时。**雪**是这个
         * 能力的招牌系统——冰尘在冠*上方*生成，然后
         * 任其穿过冠落回下来。项目中其他一切都是向上抛的，
         * 而环内的一场缓慢飘落，正是说明它上方的空气
         * 在结冰而不是在燃烧的那一笔。
         */
        mistRate: 240, // 从边缘倾泻而下的冷空气，粒子/秒
        mistSize: 1.1,
        mistSpeed: 1.6,
        mistLifetime: 3.0,
        mistOpacity: 0.055,
        mistRise: -0.12, // 负值：冷空气重，它下沉并铺开
        mistTurbulence: 0.4,
        colorMistA: '#f2feff',
        colorMistB: '#cdefff',
        colorMistC: '#8ec9e8',
        colorMistD: '#0a2c42',
        shardSize: 0.07, // 冰屑
        shardSpeed: 6.5,
        shardLifetime: 1.6,
        shardGravity: -15.0,
        breachShards: 3, // 一块碎片破面而出时抛出的冰屑数
        shatterShards: 5, // ……以及它崩解时
        colorShardA: '#ffffff',
        colorShardB: '#cdefff',
        colorShardC: '#8ee8ff',
        colorShardD: '#0a3c55',
        glitterRate: 150, // 从冰面上升起的闪光
        glitterSize: 0.05,
        glitterSpeed: 2.6,
        glitterLifetime: 2.4,
        glitterRise: 1.3, // 向上漂移，米/秒
        glitterTurbulence: 0.6,
        glitterGlow: 1.0,
        colorGlitterA: '#ffffff',
        colorGlitterB: '#6fe0ff',
        colorGlitterC: '#bdeeff',
        colorGlitterD: '#062434',
        snowRate: 110, // 穿过冠落回的冰尘
        snowSize: 0.045,
        snowSpeed: 0.9, // 它一开始被向下推的力度
        snowLifetime: 3.2,
        snowFall: -1.1, // 作用在它上面的重力，米/秒²
        snowTurbulence: 0.85, // 把这场下落变成飘移的东西
        snowGlow: 0.9,
        snowInset: 0.85, // 它落在边界内侧多远，× zoneRadius
        snowHeight: 1.35, // 它从何处开始，× 墙的高度
        colorSnowA: '#ffffff',
        colorSnowB: '#e4f9ff',
        colorSnowC: '#a7e6ff',
        colorSnowD: '#0c3348',

        /* --- 动态光 --- */
        lightIntensity: 14,
        lightRadius: 16,
        lightHeight: 0.45, // 灯光位于冠的多高处，0..1
        lightColor: '#8ee8ff',

        /* --- 抛出、绽放与维持 --- */
        muzzleSize: 0.55, // 前沿离开时手部的那一团
        muzzleIntensity: 1.5,
        castFlash: 0.08, // 释放时的屏幕闪光
        colorCastFlash: '#cdefff',
        burstSize: 4.0, // 绽放时抛出的蒸气外壳，米
        burstIntensity: 1.1,
        burstShards: 120, // 绽放时额外的冰屑
        burstMist: 70,
        burstGlitter: 140,
        vapourRate: 1.6, // 墙站立期间脱落的蒸气外壳，/秒
        vapourSize: 1.4, // 一个的半径，米
        vapourIntensity: 0.7,
        impactShake: 0.85,
        shakeDuration: 0.85,
        holdShake: 0.05, // 冠站立期间的持续震动
        impactFlash: 0.2,
        rumble: 0.045, // 前沿疾冲出去时的震动
        colorBurstA: '#a7e6ff',
        colorBurstB: '#cdefff',
        colorBurstC: '#ffffff',
        colorFlash: '#cdefff', // 它绽放时全屏的闪光
    },

    /* ------------------------------------------------------------------ */
    /* 摄像机装置                                                          */
    /* ------------------------------------------------------------------ */
    camera: {
        distance: 11.5,
        minDistance: 3.5,
        maxDistance: 30,
        zoomSpeed: 1.0,
        zoomDamping: 0.002,
        minPolar: 0.35,
        maxPolar: 1.32,
        fov: 46,
        targetHeight: 1.35,
        damping: 0.06,
        autoFrame: 0.35, // 装置朝一次进行中的施放漂移的强度
    },

    /* ------------------------------------------------------------------ */
    /* 环境与光照                                                          */
    /* ------------------------------------------------------------------ */
    environment: {
        // 一个暗色电影舞台：一盏冷色主光、一道从背后来的更冷的轮廓光，
        // 几乎没有补光，所以冰是屏幕上最亮的东西，而雾可以
        // 把地板吞进背景里。
        sunIntensity: 2.6,
        sunColor: '#e8f3ff',
        sunAzimuth: 2.95,
        sunElevation: 0.6,
        ambientIntensity: 0.14,
        ambientColor: '#8ea8d8',
        hemiIntensity: 0.36,
        hemiSkyColor: '#bdd7ff',
        hemiGroundColor: '#3a4552',
        rimIntensity: 1.1,
        rimColor: '#9ec2ff',
        rimAzimuth: 5.45,
        rimElevation: 0.35,
        envIntensity: 0.32,
        backgroundColor: '#121820',
        // 雾被拉得很远，所以它只是把地板的远边缘溶解进
        // 背景里，而不是压在动作之上。开关和范围
        // 在编辑器里都是实时的（Environment → Backdrop 里的雾与尘）。
        fogEnabled: true,
        fogColor: '#121820',
        fogNear: 26,
        fogFar: 135,
        shadowBias: -0.0008,
        shadowRadius: 2.2,
        floorColor: '#191f27',
        floorTint: '#232b35',
        floorRoughness: 0.88,
        floorSheen: 0.34,
        floorPool: 0.8,
        // 铺在地面上的石砖：ambientCG Rock030（CC0），一块粗糙的
        // 天然岩石，存放在 public/textures/cathedral。`floorTextureScale` 是一块砖覆盖
        // 多少米地面；`floorTexTint` 把灰色石头朝 `floorTint` 调色，
        // 好让它融进冷色舞台的调色板，而不是跟它打架。
        floorTexture: false,
        floorTextureScale: 12.0,
        floorNormalScale: 0.85,
        floorTexTint: 0.4,
        dustAmount: 0.85,
        contactShadow: 0.55,
    },

    /* ------------------------------------------------------------------ */
    /* 后期处理                                                            */
    /* ------------------------------------------------------------------ */
    post: {
        enabled: true,
        exposure: 1.05,
        // 阈值刻意压在冰体受光值之上：只有边缘、
        // 闪光点和命中处应该泛光，而不是整片水晶原野。
        // 强度刻意接近零——水晶的轮廓自己在承载
        // 可读性，而泛光正是把它吃掉的东西。想要那圈光晕就把它推高。
        bloomStrength: 0.03,
        bloomRadius: 0.6,
        bloomThreshold: 0.88,
        vignette: 0.52,
        chromaticAberration: 0.4,
        contrast: 1.12,
        saturation: 1.08,
        temperature: -0.03, // + 暖 / - 冷
        lift: -0.008,
        gain: 1.0,
        grain: 0.045,
        // 对 LAYER.DISTORTION 写入的屏幕空间扭曲的总增益——热浪扭曲
        // 链条上的最后一环。以屏幕宽度为单位，所以窗口
        // 改变大小时它待在原地。
        distortion: 0.045,
        flashStrength: 1.0,
    },
};

/**
 * 一个能力如何被瞄准。
 *
 * `LINE` 是沙盒最初就有的技能弹道：一支绕施放者摆动的箭头，
 * 沿它的长度施放。`ZONE` 是**远距施放**——一个落在光标处、带一圈
 * 加粗边界的圆，它回答了地面指向的 AoE 在你出手之前
 * 必须回答的唯一问题：这要占多大地方。两者都归结为同一个
 * `cast(origin, direction, distance)` 事件，所以一个能力永远不必关心
 * 是哪一个在瞄准它；一个区域能力只需把目标读成 `pointAt(1)`，
 * 然后从那里向外推演。
 */
export const CastShape = Object.freeze({
    LINE: 'line',
    ZONE: 'zone',
});

/**
 * 能力 id，按槽位顺序排列。
 *
 * `AbilityManager`、HUD、瞄准控制器和编辑器都以这个数组为键，
 * 而它的下标就是键盘绑定的槽位——新增第三个
 * 能力就是加一个新文件、在这里加一项，再在上面加一个设置块。
 */
export const ELEMENTS = ['ice', 'thunder', 'meteor', 'beam', 'snare', 'glacier'];

/**
 * 注册表元数据：一个能力如何被呈现，以及如何被瞄准。
 *
 * `key` 必须与 `InputManager` 匹配。`cast` 由 `AimController` 读取，用来
 * 在箭头和圆之间选择；省略它，这个能力就是直线施放。
 */
export const ELEMENT_META = {
    ice: { label: 'Frost Lance', accent: '#5fd0ff', key: 'Q', hint: 'Frost Lance' },
    thunder: { label: 'Storm Lance', accent: '#7fb4ff', key: 'E', hint: 'Storm Lance' },
    meteor: { label: 'Cinder Fall', accent: '#ff8a3c', key: 'R', hint: 'Cinder Fall' },
    beam: { label: 'Nova Beam', accent: '#7ff0ff', key: 'F', hint: 'Nova Beam' },
    snare: {
        label: 'Voltaic Snare',
        accent: '#a98bff',
        key: 'V',
        hint: 'Voltaic Snare',
        cast: CastShape.ZONE,
    },
    glacier: {
        label: 'Glacial Crown',
        accent: '#8ee8ff',
        key: 'X',
        hint: 'Glacial Crown',
        cast: CastShape.ZONE,
    },
};

/** 给定能力的瞄准方式。除非其元数据另有说明，否则是直线施放。 */
export function castShapeOf(element) {
    return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/** 一次远距施放将覆盖的落点范围，米。直线施放为 0。 */
export function zoneRadiusOf(element) {
    return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** 由“重置为默认值”和预设系统使用的不可变快照。 */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * 把一个普通对象就地深合并进 `settings`。
 * 保留既有对象的同一性，这样每一处活绑定都继续有效。
 */
export function applySettings(patch, target = settings) {
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
        } else if (key in target) {
            target[key] = value;
        }
    }
    return target;
}

/** 把每个值恢复为出厂默认值（就地）。 */
export function resetSettings() {
    applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** 当前状态的可序列化克隆。 */
export function snapshotSettings() {
    return structuredClone(settings);
}
