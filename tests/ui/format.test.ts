import { describe, it, expect } from "vitest";
import { fmtDuration, fmtInstant, fmtCount, fmtPercent, fmtDash, fmtBytesMb } from "../../admin-ui/js/pure/format.mjs";

/**
 * 格式化是「面板不撒谎」的第一道关口：**接口失败显示 —，绝不伪造 0**。
 * 这几条防的是同一类真实故障——把 `null` 渲染成 `0`、把「未知」渲染成一个看起来确定的值。
 */
describe("fmtDash：null / undefined / NaN 一律 —，绝不伪造 0", () => {
  it("三种「没有值」都渲染成破折号", () => {
    for (const v of [null, undefined, Number.NaN]) expect(fmtDash(v)).toBe("—");
  });
  it("真正的 0 照常显示 0——把 0 也吞成 — 是另一个方向的撒谎", () => {
    expect(fmtDash(0)).toBe("0");
  });
});

describe("fmtDuration", () => {
  it("边界值写字面量，不写 THRESHOLD ± 1（第 6 种假阳性）", () => {
    expect(fmtDuration(0)).toBe("0秒");
    expect(fmtDuration(999)).toBe("0秒");
    expect(fmtDuration(1000)).toBe("1秒");
    expect(fmtDuration(59_000)).toBe("59秒");
    expect(fmtDuration(60_000)).toBe("1分0秒");
    expect(fmtDuration(3_599_000)).toBe("59分59秒");
    expect(fmtDuration(3_600_000)).toBe("1小时0分");
    expect(fmtDuration(86_400_000)).toBe("1天0小时");
  });
  it("负数（时钟回拨 / 冷却已过期）显示 0 而不是 -1秒", () => {
    expect(fmtDuration(-5000)).toBe("0秒");
  });
  it("没有值时是 —", () => {
    expect(fmtDuration(null)).toBe("—");
  });
});

describe("fmtCount / fmtPercent", () => {
  it("大数加千分位，不做 1.2k 这种有损缩写——运维要的是准确数字", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(999)).toBe("999");
    expect(fmtCount(1000)).toBe("1,000");
    expect(fmtCount(1234567)).toBe("1,234,567");
    expect(fmtCount(null)).toBe("—");
  });
  it("分母为 0 时是 —，不是 0%——「一次都没跑过」和「成功率 0%」是两回事", () => {
    expect(fmtPercent(0, 0)).toBe("—");
    expect(fmtPercent(0, 10)).toBe("0.0%");
    expect(fmtPercent(1, 3)).toBe("33.3%");
    expect(fmtPercent(10, 10)).toBe("100.0%");
  });
});

describe("fmtBytesMb：概览页 RSS 展示，0 与没有值必须分得开", () => {
  it("没有值时是 —，不是 0 MB——刚起的进程 RSS 确实可能很小但绝不会是 0", () => {
    for (const v of [null, undefined, Number.NaN]) expect(fmtBytesMb(v)).toBe("—");
  });
  it("字节数换算成 MB，一位小数", () => {
    expect(fmtBytesMb(0)).toBe("0.0 MB");
    expect(fmtBytesMb(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytesMb(123_456_789)).toBe("117.7 MB");
  });
});

describe("fmtInstant", () => {
  it("null 是 —；有值时用注入的时区偏移，不读运行环境的本地时区", () => {
    // 时区从参数进：面板要标注时区，而「运行环境的本地时区」在 Worker 上是 UTC、
    // 在用户浏览器里是本地时区，同一份数据两种显示 —— 那就是面板在撒谎。
    expect(fmtInstant(null, 0)).toBe("—");
    expect(fmtInstant(0, 0)).toBe("1970-01-01 00:00:00 UTC+0");
    expect(fmtInstant(0, 8 * 3600_000)).toBe("1970-01-01 08:00:00 UTC+8");
  });
});
