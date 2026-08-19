import type { Logger, LogEntry, LogLevel } from "../ports/logger.js";

/**
 * 前缀标签。五语言 REGISTRAR.md 的排障小节对外承诺「补池过程中的日志统一带
 * `[registrar]` 前缀，可据此过滤」（P2 的 M4）。事件名的命名空间就是这个前缀的
 * 唯一依据——不再靠每个调用点自己手写字符串，那正是 M4 当初漏掉 14 条的成因。
 */
function prefixOf(event: string): string {
  return event.startsWith("registrar.") ? "[registrar]" : "[agnes2api]";
}

const METHOD: Readonly<Record<LogLevel, "debug" | "info" | "warn" | "error">> = {
  debug: "debug", info: "info", warn: "warn", error: "error",
};

/**
 * 全部 C0 与 C1 控制字符。**原来只清 `[\r\n]`，那是按「输入是自己人」建模的。**
 *
 * 而 `admin.login_failed` 的 `path` 字段装的是**任意未鉴权请求**的路径
 * （Hono 的 `c.req.path` 还是百分号解码后的值），于是
 * `curl 'http://gw/admin/api/z%1b[2J%1b[31mFAKE'` 就能把裸 ANSI 转义写进容器日志，
 * `docker logs` / `tail` 直接被操纵（清屏、变色，也能盖掉前面的行）；`%00` 同样穿透。
 * 审计行必须对着「值由攻击者书写」这个前提来建模，所以这里清的是整个控制字符集，
 * 不是几个已知的坏字符。
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * 把字段值压成单行。多行内容（异常栈、上游返回的 HTML）会把一条日志撕成多条，
 * 而运维的排障姿势是按行 grep `[registrar]`——被撕开的后续行拿不到前缀，等于丢失。
 */
function flatten(v: string | number | boolean | null): string {
  return String(v).replace(CONTROL_CHARS, " ");
}

/**
 * logfmt 引用。**这是「一个值只能占一个字段」这条不变量的全部实现。**
 *
 * 不引用时，值里的空格与 `=` 会把一个字段撕成好几个：实测
 * `curl 'http://gw/admin/api/x%20ip=8.8.8.8%20evil=1'`（零凭据）落盘的是
 *   `… admin.login_failed 管理接口凭据无效 ip=null path=/admin/api/x ip=8.8.8.8 evil=1 hasHeader=false`
 * ——一个未鉴权的调用方伪造出了 `ip=` 字段，而这条日志是设计文档承诺的**唯一爆破痕迹**，
 * P3b 的事件板块还要按它做面板筛选。
 *
 * `JSON.stringify` 顺带把内部的 `"` 与 `\` 转义掉，因此引号本身也撕不开字段。
 * 空串一律加引号：`k=` 与「这个字段不存在」在 logfmt 里长得一样。
 */
function quote(s: string): string {
  return s === "" || /[\s="]/.test(s) ? JSON.stringify(s) : s;
}

export class ConsoleLogger implements Logger {
  log(e: Omit<LogEntry, "ts">): void {
    let line = `${prefixOf(e.event)} ${e.event}`;
    // `msg` 刻意不引用：它是本仓源码里的固定文案（不接受调用方数据），
    // 引起来只会让每一行日志都变得难读。控制字符照样清掉。
    if (e.msg) line += ` ${flatten(e.msg)}`;
    if (e.fields) {
      for (const [k, v] of Object.entries(e.fields)) line += ` ${k}=${quote(flatten(v))}`;
    }
    console[METHOD[e.level]](line);
  }
}
