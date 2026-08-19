/**
 * 面板的格式化。**全部纯函数**：无副作用、不读环境、时间与时区都从参数进。
 *
 * 时区必须从参数进，不许读运行环境的本地时区：Worker 上是 UTC、用户浏览器里是本地时区，
 * 同一份数据两种显示就是面板在撒谎。面板统一按「用户浏览器时区」渲染并**标注偏移**，
 * 偏移量由调用方算好传进来。
 *
 * 这个目录下的文件受三条硬规则约束，规则全文见 admin-ui/README.md。
 */

/** 没有值就是没有值。**绝不伪造 0**——接口失败显示 0 会让运维以为「真的是零」。 */
export function fmtDash(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number" && !Number.isFinite(v)) return "—";
  return String(v);
}

/** 千分位。**刻意不做 1.2k 这种有损缩写**：运维要的是准确数字。 */
export function fmtCount(v) {
  if (v === null || v === undefined || typeof v !== "number" || !Number.isFinite(v)) return "—";
  const neg = v < 0;
  const s = String(Math.trunc(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
}

/**
 * 百分比，一位小数。
 * **分母为 0 时返回 —，不是 0.0%**：「一次都没跑过」与「成功率 0%」是两回事，
 * 后者会让运维去查一把其实从没被用过的 key。
 */
export function fmtPercent(num, den) {
  if (typeof num !== "number" || typeof den !== "number") return "—";
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}

/**
 * 时长。负数（时钟回拨、冷却已到期）一律按 0 渲染——显示「-3秒」只会让人以为读错了。
 * 只到两档精度：再细的位数在运维场景里没有信息量，只会让列宽跳动。
 */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const t = Math.max(0, Math.trunc(ms));
  const s = Math.trunc(t / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.trunc(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  const h = Math.trunc(m / 60);
  if (h < 24) return `${h}小时${m % 60}分`;
  return `${Math.trunc(h / 24)}天${h % 24}小时`;
}

/**
 * 字节数 → MB，一位小数。**只用于概览页的 RSS 展示**，`0` 与「没有值」必须分得开：
 * 一个刚起的进程 RSS 确实可能非常小，但绝不会是 0——把「没有值」渲染成 `0 MB`
 * 会让运维误读成「进程占用真的是零」。
 */
export function fmtBytesMb(bytes) {
  if (bytes === null || bytes === undefined || typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 时刻。`offsetMs` 是要渲染的时区相对 UTC 的偏移（毫秒），由调用方算好传进来。
 * 尾巴上的 `UTC+N` **必须有**：不标时区的时间戳在多 colo 部署里毫无意义。
 */
export function fmtInstant(ms, offsetMs) {
  if (ms === null || ms === undefined || typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const off = typeof offsetMs === "number" && Number.isFinite(offsetMs) ? offsetMs : 0;
  const d = new Date(ms + off);
  const p = (n, w) => String(n).padStart(w, "0");
  const body = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1, 2)}-${p(d.getUTCDate(), 2)} `
    + `${p(d.getUTCHours(), 2)}:${p(d.getUTCMinutes(), 2)}:${p(d.getUTCSeconds(), 2)}`;
  const hours = off / 3600_000;
  const sign = hours < 0 ? "-" : "+";
  const abs = Math.abs(hours);
  const label = Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${body} UTC${sign}${label}`;
}
