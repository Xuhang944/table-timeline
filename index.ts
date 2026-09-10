/**
 * 表格时间线视图（官方表格视图插件）。
 *
 * 字段驱动（无硬编码模式）：
 * - 取第一个 `duration` 字段决定卡片宽度（60px/秒，最短 120px）与播放时长；无该字段 → 等宽卡片 + 固定 3s/行
 * - 取第一个 `image` 字段供缩略图/大图；无图镜头显示首个 text 字段摘要文字卡片
 * - 点击卡片 = 跳选该行（经 ctx.table.selectRow 与表格视图 selectedRowId 联动，停止播放）
 *
 * 预演：上方预览区（当前行大图/文字卡片）+ 控制条（播放/暂停/停止、当前时间/总时长）+
 * 时间轴（卡片流 + 刻度尺 + 播放头）。rAF 驱动播放头，纯前端零依赖；
 * 播放中当前卡片自动滚入视野；组件卸载（切视图/关窗）自动停止。
 *
 * 数据来源：ctx.table.snapshot() + `table:changed` 事件订阅当前表格快照（含行/字段/选中行/协作远端选中行用户色）；
 * 图片条目经 ctx.table.resolveImage 解析为 dataURL（失败走文字摘要兜底）。
 *
 * 入口自包含（无运行时 import；`import type` 为类型注解，转译时擦除）；JSX 经转译引用
 * React.createElement（宿主提供 React 全局）；样式只用 inline style + CSS 变量（Tailwind 类不可依赖）。
 */
import type { Context } from "@atelyx/cordis";

/** 表格字段（插件侧最小声明，与宿主 PluginTableSnapshot 契约同构）。 */
interface Field {
  id: string;
  type: string;
}
/** 单元格样式（可映射子集：粗斜下划删/文字色/背景/字号）。 */
interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
  bg?: string;
  size?: number;
}
/** 表格行（插件侧最小声明；values 按字段 id 取值，styles 为单元格样式表）。 */
interface Row {
  id: string;
  values: Record<string, unknown>;
  styles?: Record<string, CellStyle>;
}
/** 表格快照（ctx.table.snapshot 返回；结构即契约）。 */
interface TableSnapshot {
  tableFile: string | null;
  fields: Field[];
  rows: Row[];
  selectedRowId: string | null;
  peerColorByRowId: Record<string, string>;
}

/** React 全局（宿主注入）最小声明。 */
interface ReactApi {
  useState<T>(init: T): [T, (value: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  useRef<T>(init: T): { current: T };
  useCallback<T extends (...args: unknown[]) => unknown>(fn: T, deps: readonly unknown[]): T;
  memo<T>(fn: T): T;
  Fragment: unknown;
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
}

/** Atelyx 宿主服务面（插件侧最小声明；宿主侧完整契约见宿主 ctx API 文档）。 */
interface AtelyxCtx extends Context {
  table: {
    snapshot(): TableSnapshot;
    selectRow(rowId: string | null): void;
    resolveImage(entry: string): Promise<string>;
  };
  slots: {
    registerTableView(opts: { kind: string; label: string; component: unknown }): () => void;
  };
}

const React = (globalThis as { React?: ReactApi }).React as ReactApi;

/** 入口：注册表格视图 + 订阅表格变更；随插件启停经 fiber 生命周期撤销。 */
export default function apply(ctx: AtelyxCtx): void {
  const table = ctx.table;
  const h = React.createElement;
  // ctx.events.on 为 fiber 级注册（卸载随插件停用撤销）；返回退订函数供组件卸载时调用。
  const onTableChanged = (cb: () => void): (() => boolean) => ctx.events.on("table:changed", cb);

  // ===== 时间线视图参数 =====
  const PX_PER_SEC = 60; // 卡片宽度：每秒时长对应 px
  const MIN_CARD_WIDTH = 120; // 时长过短/缺失兜底
  const EQUAL_CARD_WIDTH = 160; // 无 duration 字段时的等宽卡片宽
  const CARD_GAP = 6; // 卡片间距
  const DEFAULT_DURATION = 3; // 无 duration 字段或值为空时每行播放秒数

  // ===== 纯函数 =====

  /** 单行播放时长：duration 字段值（>0 才有效），缺省 3s。 */
  function rowDuration(row: Row, durationFieldId: string | undefined): number {
    if (!durationFieldId) return DEFAULT_DURATION;
    const v = row.values[durationFieldId];
    return typeof v === "number" && v > 0 ? v : DEFAULT_DURATION;
  }

  /** 卡片宽度：有时长字段 = max(时长×比例, 最短宽)；无 = 等宽。 */
  function cardWidthAt(duration: number, hasDurationField: boolean): number {
    return hasDurationField ? Math.max(duration * PX_PER_SEC, MIN_CARD_WIDTH) : EQUAL_CARD_WIDTH;
  }

  /** 行图片值（ImageCellValue.images；非图片值/缺省 → 空数组）。 */
  function imagesOf(row: Row, field: Field | undefined): string[] {
    const v = field ? row.values[field.id] : undefined;
    return v !== undefined && typeof v === "object" && v !== null ? (v as { images?: unknown }).images as string[] : [];
  }

  /** 单元格样式 → CSS（只映射可直接表达的子集：粗斜下划删/文字色/背景/字号；字体预设键为宿主内部映射，不复制）。 */
  function cellStyleCss(st: CellStyle | undefined): Record<string, string | number> | null {
    if (!st) return null;
    const out: Record<string, string | number> = {};
    if (st.b) out.fontWeight = 700;
    if (st.i) out.fontStyle = "italic";
    if (st.u) out.textDecoration = "underline";
    if (st.s) out.textDecoration = (out.textDecoration ? out.textDecoration + " " : "") + "line-through";
    if (st.color) out.color = st.color;
    if (st.bg) out.background = st.bg;
    if (st.size) out.fontSize = st.size + "px";
    return Object.keys(out).length > 0 ? out : null;
  }

  function formatTime(t: number): string {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ===== 内联 SVG 图标（播放/暂停/停止） =====

  function PlayIcon() {
    return h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "currentColor", style: { marginLeft: 2 } }, h("path", { d: "M8 5v14l11-7z" }));
  }
  function PauseIcon() {
    return h("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M6 5h4v14H6zM14 5h4v14h-4z" }));
  }
  function StopIcon() {
    return h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "currentColor" }, h("path", { d: "M6 6h12v12H6z" }));
  }

  // ===== 图片解析 hook（等价于宿主内 useTableImageSrc） =====

  function useTableImageSrc(entry: string): { src: string | null; failed: boolean } {
    const [st, setSt] = React.useState({ src: null as string | null, failed: false });
    React.useEffect(() => {
      let alive = true;
      if (!entry) {
        setSt({ src: null, failed: false });
        return;
      }
      if (entry.startsWith("data:")) {
        setSt({ src: entry, failed: false }); // 遗留内嵌 dataURL：同步透传
        return;
      }
      setSt({ src: null, failed: false });
      table
        .resolveImage(entry)
        .then((url) => {
          if (alive) setSt({ src: url, failed: false });
        })
        .catch(() => {
          if (alive) setSt({ src: null, failed: true });
        });
      return () => {
        alive = false;
      };
    }, [entry]);
    return st;
  }

  // ===== 子组件（memo 隔离；播放中 playhead 不参与 props，仅换行时重渲染） =====

  function CardThumb(props: { entry: string; summary: string }) {
    const src = useTableImageSrc(props.entry).src;
    if (!src) {
      return h(
        "div",
        {
          style: {
            width: "100%",
            height: "100%",
            padding: "6px",
            fontSize: 10,
            lineHeight: "16px",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-muted)",
          },
        },
        props.summary || "…",
      );
    }
    return h("img", { src, alt: "", style: { width: "100%", height: "100%", objectFit: "cover" }, draggable: false });
  }

  const TimelineCards = React.memo(function TimelineCards(props: {
    rows: Row[];
    selectedRowId: string | null;
    shotIndex: number;
    durations: number[];
    hasDurationField: boolean;
    imageField: Field | undefined;
    textField: Field | undefined;
    peerColorByRowId: Record<string, string>;
    onJump: (index: number) => void;
  }) {
    const cards: unknown[] = [];
    for (let i = 0; i < props.rows.length; i++) {
      const row = props.rows[i];
      const isSelected = row.id === props.selectedRowId;
      const isCurrent = i === props.shotIndex;
      const images = imagesOf(row, props.imageField);
      const summary =
        props.textField && typeof row.values[props.textField.id] === "string" ? String(row.values[props.textField.id]) : "";
      const cellStyle = props.textField && row.styles ? cellStyleCss(row.styles[props.textField.id]) : null;
      cards.push(
        h(
          "div",
          {
            key: row.id,
            "data-row-id": row.id,
            "data-shot-id": i,
            onClick: () => props.onJump(i),
            title: "行 " + (i + 1) + " · " + props.durations[i] + " 秒",
            style: {
              display: "flex",
              flexDirection: "column",
              borderRadius: 4,
              cursor: "pointer",
              overflow: "hidden",
              flexShrink: 0,
              width: cardWidthAt(props.durations[i], props.hasDurationField),
              border: "1px solid " + (isCurrent ? "var(--accent)" : props.peerColorByRowId[row.id] || "var(--border)"),
              background: isSelected ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg-secondary)",
              outline: isCurrent ? "1px solid var(--accent)" : undefined,
            },
          },
          [
            h(
              "div",
              {
                key: "thumb",
                style: {
                  height: 80,
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--bg-tertiary)",
                },
              },
              images.length > 0
                ? h(CardThumb, { entry: images[0], summary })
                : h(
                    "div",
                    {
                      style: {
                        width: "100%",
                        height: "100%",
                        padding: "6px",
                        fontSize: 10,
                        lineHeight: "16px",
                        overflow: "hidden",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: "var(--text-muted)",
                        ...cellStyle,
                      },
                    },
                    summary || "行 " + (i + 1),
                  ),
            ),
            h(
              "div",
              {
                key: "meta",
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "4px 6px",
                  fontSize: 10,
                  color: "var(--text-muted)",
                },
              },
              [h("span", { key: "idx" }, i + 1), h("span", { key: "dur" }, props.durations[i] + "s")],
            ),
          ],
        ),
      );
    }
    return h(React.Fragment, null, cards);
  });

  /** 刻度尺：memo 隔离——播放中 totalDuration 不变则跳过每帧重建。 */
  const TimelineRuler = React.memo(function TimelineRuler(props: { totalDuration: number }) {
    const marks: unknown[] = [];
    const count = Math.floor(props.totalDuration / 5) + 1;
    for (let k = 0; k < count; k++) {
      const t = k * 5;
      marks.push(
        h(
          "div",
          {
            key: t,
            style: {
              position: "absolute",
              top: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              left: t * PX_PER_SEC,
            },
          },
          [
            h("div", { key: "tick", style: { width: 1, height: 12, background: "var(--text-muted)", opacity: 0.5 } }),
            h("span", { key: "label", style: { fontSize: 9, marginTop: 2, color: "var(--text-muted)" } }, t + "s"),
          ],
        ),
      );
    }
    return h("div", { style: { position: "relative", height: 20 } }, marks);
  });

  /** 预览区（当前行大图/文字卡片）：memo 隔离——播放中仅换行（currentRow 引用变化）时重渲染。 */
  const TimelinePreview = React.memo(function TimelinePreview(props: {
    currentRow: Row;
    shotIndex: number;
    imageField: Field | undefined;
    textField: Field | undefined;
    cover: { src: string | null; failed: boolean };
    durationSec: number;
  }) {
    const images = imagesOf(props.currentRow, props.imageField);
    const textValue =
      props.textField && typeof props.currentRow.values[props.textField.id] === "string"
        ? String(props.currentRow.values[props.textField.id])
        : "";
    const cellStyle = props.textField && props.currentRow.styles ? cellStyleCss(props.currentRow.styles[props.textField.id]) : null;
    let content: unknown;
    if (images.length > 0 && !props.cover.failed) {
      content = props.cover.src
        ? h("img", {
            src: props.cover.src,
            alt: "行 " + (props.shotIndex + 1),
            style: { maxHeight: "55vh", maxWidth: "100%", objectFit: "contain", borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.3)" },
            draggable: false,
          })
        : h(
            "div",
            {
              style: {
                width: 288,
                aspectRatio: "16 / 9",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                background: "var(--bg-secondary)",
                color: "var(--text-muted)",
                border: "1px dashed var(--border)",
              },
            },
            "图片加载中…",
          );
    } else if (textValue) {
      content = h(
        "div",
        {
          style: {
            maxWidth: 576,
            maxHeight: "55vh",
            overflow: "auto",
            padding: 16,
            borderRadius: 8,
            whiteSpace: "pre-wrap",
            fontSize: 14,
            background: "var(--bg-secondary)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
            ...cellStyle,
          },
        },
        textValue,
      );
    } else {
      content = h(
        "div",
        {
          style: {
            padding: "12px 24px",
            borderRadius: 8,
            fontSize: 14,
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            border: "1px dashed var(--border)",
          },
        },
        "行 " + (props.shotIndex + 1) + "（无图片与文本内容）",
      );
    }
    return h(
      "div",
      {
        style: {
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          position: "relative",
        },
      },
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, maxWidth: "100%" } },
        content,
        h("div", { style: { fontSize: 12, color: "var(--text-muted)" } }, "行 " + (props.shotIndex + 1) + " · " + props.durationSec + " 秒"),
      ),
    );
  });

  /** 播放头进度线：left 每帧都变，memo 比较必然失效，直接普通函数组件。 */
  function PlayheadLine(props: { visible: boolean; left: number }) {
    if (!props.visible) return null;
    return h("div", {
      style: {
        position: "absolute",
        top: 0,
        bottom: 0,
        width: 2,
        pointerEvents: "none",
        zIndex: 10,
        left: 12 + props.left,
        background: "var(--accent)",
      },
    });
  }

  // ===== 主组件 =====

  function TimelineView() {
    const [snap, setSnap] = React.useState<TableSnapshot | null>(null);
    React.useEffect(() => {
      // 初次快照 + 变更订阅（退订 = 组件卸载 + 插件停用双路径）
      const push = () => setSnap(table.snapshot());
      push();
      return onTableChanged(push);
    }, []);

    const rows = snap ? snap.rows : [];
    const fields = snap ? snap.fields : [];
    const selectedRowId = snap ? snap.selectedRowId : null;
    const tableFile = snap ? snap.tableFile : null;
    const peerColorByRowId = snap ? snap.peerColorByRowId : {};

    const durationField = fields.find((f) => f.type === "duration");
    const imageField = fields.find((f) => f.type === "image");
    const textField = fields.find((f) => f.type === "text");

    const durations = React.useMemo(
      () => rows.map((r) => rowDuration(r, durationField ? durationField.id : undefined)),
      [rows, durationField],
    );
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const hasDurationField = !!durationField;
    const totalWidth =
      rows.reduce((acc, _r, i) => acc + cardWidthAt(durations[i], hasDurationField), 0) +
      Math.max(0, rows.length - 1) * CARD_GAP;

    // ===== 播放状态：播放头 = 时间轴绝对秒数 =====
    const [playing, setPlaying] = React.useState(false);
    const [playhead, setPlayhead] = React.useState(0);
    const playheadRef = React.useRef(0);
    const finished = rows.length > 0 && playhead >= totalDuration;

    const shotIndex = React.useMemo(() => {
      if (rows.length === 0) return -1;
      let acc = 0;
      for (let i = 0; i < durations.length; i++) {
        acc += durations[i];
        if (playhead < acc) return i;
      }
      return durations.length - 1;
    }, [rows.length, durations, playhead]);

    // 切表格复位播放（宿主按文件 key 重挂载已复位，此处兜底双保险）
    const prevFileRef = React.useRef(tableFile);
    React.useEffect(() => {
      if (prevFileRef.current !== tableFile) {
        prevFileRef.current = tableFile;
        setPlaying(false);
        playheadRef.current = 0;
        setPlayhead(0);
      }
    }, [tableFile]);

    // rAF 播放
    React.useEffect(() => {
      if (!playing) return;
      let raf = 0;
      let last = performance.now();
      const tick = (now: number) => {
        playheadRef.current += (now - last) / 1000;
        last = now;
        if (playheadRef.current >= totalDuration) {
          playheadRef.current = totalDuration;
          setPlayhead(totalDuration);
          setPlaying(false);
          return;
        }
        setPlayhead(playheadRef.current);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, totalDuration]);

    // 播放中当前卡片滚入视野
    const cardsRef = React.useRef<{ querySelector(sel: string): { scrollIntoView(opts: unknown): void } | null } | null>(null);
    React.useEffect(() => {
      if (!playing || shotIndex < 0) return;
      const el = cardsRef.current && cardsRef.current.querySelector('[data-shot-id="' + shotIndex + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }, [playing, shotIndex]);

    /** 各卡片起点时间（前缀和一次计算，播放头定位 / 跳选共用）。 */
    const shotStarts = React.useMemo(() => {
      const starts: number[] = [];
      let acc = 0;
      for (let i = 0; i < durations.length; i++) {
        starts.push(acc);
        acc += durations[i];
      }
      return starts;
    }, [durations]);

    /** 播放头像素位置：累计前序卡片宽度 + 当前卡内比例。 */
    const playheadPx = React.useMemo(() => {
      if (rows.length === 0 || shotIndex < 0) return 0;
      let acc = 0;
      for (let i = 0; i < shotIndex; i++) acc += cardWidthAt(durations[i], hasDurationField) + CARD_GAP;
      const shotStart = shotStarts[shotIndex] || 0;
      const frac = durations[shotIndex] > 0 ? (playhead - shotStart) / durations[shotIndex] : 0;
      return acc + Math.min(1, Math.max(0, frac)) * cardWidthAt(durations[shotIndex], hasDurationField);
    }, [rows.length, shotIndex, durations, shotStarts, playhead, hasDurationField]);

    /** 跳选行：停止播放并定位到该行起点（与表格视图选中联动）。 */
    const jumpTo = React.useCallback((index: number) => {
      setPlaying(false);
      playheadRef.current = shotStarts[index] || 0;
      setPlayhead(playheadRef.current);
      table.selectRow(rows[index] ? rows[index].id : null);
    }, [shotStarts, rows]);

    // 预览区大图条目（当前播放行首个 image）→ dataURL；失败时 failed 供预览回落文字摘要
    const coverEntry =
      shotIndex >= 0 && imageField && rows[shotIndex] ? imagesOf(rows[shotIndex], imageField)[0] : undefined;
    const cover = useTableImageSrc(coverEntry || "");

    // ===== 空态 =====
    if (!tableFile) {
      return h(
        "div",
        { style: { height: "100%", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" } },
        h("p", { style: { fontSize: 14, color: "var(--text-muted)" } }, "未打开表格"),
      );
    }
    if (rows.length === 0) {
      return h(
        "div",
        { style: { height: "100%", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)" } },
        h("p", { style: { fontSize: 14, color: "var(--text-muted)" } }, "暂无行数据，请先在表格视图添加行。"),
      );
    }

    const currentRow = rows[shotIndex];

    return h(
      "div",
      { style: { height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary)" } },
      [
        h(TimelinePreview, {
          key: "preview",
          currentRow,
          shotIndex,
          imageField,
          textField,
          cover,
          durationSec: durations[shotIndex],
        }),
        // 控制条
        h(
          "div",
          {
            key: "controls",
            style: {
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "6px 12px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-secondary)",
            },
          },
          [
            h(
              "button",
              {
                key: "play",
                onClick: () => {
                  if (finished) {
                    playheadRef.current = 0;
                    setPlayhead(0);
                    setPlaying(true);
                  } else {
                    setPlaying((v) => !v);
                  }
                },
                title: playing ? "暂停" : finished ? "重播" : "播放",
                style: {
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  cursor: "pointer",
                  border: "none",
                  background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                  color: "var(--accent)",
                },
              },
              playing ? h(PauseIcon) : h(PlayIcon),
            ),
            h(
              "button",
              {
                key: "stop",
                onClick: () => {
                  setPlaying(false);
                  playheadRef.current = 0;
                  setPlayhead(0);
                },
                title: "停止（回到开头）",
                style: {
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                },
              },
              h(StopIcon),
            ),
            h("span", { key: "time", style: { fontFamily: "monospace" } }, formatTime(playhead) + " / " + formatTime(totalDuration)),
          ],
        ),
        // 时间轴：刻度尺 + 卡片流 + 播放头
        h(
          "div",
          { key: "timeline", style: { flexShrink: 0, borderTop: "1px solid var(--border)", overflowX: "auto" } },
          h(
            "div",
            { style: { position: "relative", width: totalWidth + 24, padding: "0 12px 10px" } },
            [
              durationField ? h(TimelineRuler, { key: "ruler", totalDuration }) : null,
              h(
                "div",
                { key: "cards", ref: cardsRef, style: { display: "flex", alignItems: "stretch", gap: CARD_GAP } },
                h(TimelineCards, {
                  rows,
                  selectedRowId,
                  shotIndex,
                  durations,
                  hasDurationField,
                  imageField,
                  textField,
                  peerColorByRowId,
                  onJump: jumpTo,
                }),
              ),
              h(PlayheadLine, { key: "playhead", left: playheadPx, visible: playing }),
            ],
          ),
        ),
      ],
    );
  }

  ctx.slots.registerTableView({ kind: "com.atelyx.table-timeline", label: "时间线", component: TimelineView });
}
