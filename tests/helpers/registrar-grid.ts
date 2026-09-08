import type { RegistrarConfig } from "../../src/core/registrar/config.js";

/**
 * 注册机装载的**对抗性输入网格**。
 *
 * ⚠️ **它只产输入，不产期望值。** 期望值一律在各自的用例里手写或由被测函数
 * 各自算出来再对比——从被测对象回填期望值是本仓登记在案的第 6 种假阳性。
 *
 * 三份用例共用同一张网格，这是刻意的：
 * · `tests/unit/registrar/config-total.test.ts` 的「整张网格跑下来一次都不抛」；
 * · `tests/unit/admin/config-validate.test.ts` 的「双向等价：configLoadBlockers ⟺ 装载器 blockers」；
 * · `tests/unit/config-fatal-matrix.test.ts` 的「没有 GATEWAY_TOKEN：整张网格恒抛 ConfigRefusal，message 逐字不变」。
 * 三处各写一张的话，「等价」就只在各自那张网格上成立，而漂移恰恰发生在没人共用的
 * 那几格上。
 *
 * ── 为什么是四张子网格拼起来，而不是一个全叉乘 ──────────────────────────────
 * 全叉乘（通道 × 凭据 × 七个数值字段 × 两侧 × 六个取值）是十万级，跑不动也读不懂。
 * 四张子网格各自把**一件事**叉满，其余维度钉死在一个已知合法的底座上：
 * ① 通道那张：`enabled` × 两侧 × 五种通道取值 × 凭据有无；
 * ② 存量旧键那张：`enabled` × 两侧 × 旧主通道五种 × 旧备通道五种 × 凭据有无；
 * ③ 数值那张：三个代表性数值字段 × 两侧 × 六种取值；
 * ④ 延迟对那张：`min` × `max` 六 × 六，两种「一边 env 一边存储」的摆法。
 * **这是网格不是穷举**，射程写在这里，别读成「等价性被证明了」。
 *
 * ⚠️ **② 是两条通道改成二选一那一轮加的，它不是凑数。** 通道那张从「主 × 备」两维
 * 叉乘收成一维之后，规模从 200 组掉到 40 组 —— 而少掉的那 160 组恰恰是**存量部署
 * 手上那份配置的形状**（`{"registrar":{"primary":…,"fallback":…}}`）。把那一维
 * 直接删掉 = 兼容读那条路径上一组对抗性输入都没有，而它正是这次改动里最容易
 * 静默出错的一段。⇒ 那一维搬进 ②，喂的是旧键。
 */

export type EnvMap = Record<string, string | undefined>;

export interface GridCase {
  /** 人话标签，用例失败时它是唯一能让人复现的东西。 */
  name: string;
  env: EnvMap;
  stored: Partial<RegistrarConfig>;
}

/** 通道字段的五种取值：缺席 / 空串 / 不认识的串 / 两条合法通道。 */
const CHANNEL_VALUES = [undefined, "", "abc", "yyds", "moemail"] as const;

/** 数值字段的六种取值。`"abc"` 只在 env 侧有意义（env 全是字符串），存储侧也照塞一遍。 */
const NUM_VALUES = ["abc", 0, -1, 1.5, null, 5] as const;

/** 两条通道的凭据都给齐的一份底座。 */
const FULL_CREDS: Partial<RegistrarConfig> = {
  yyds: { baseUrl: "https://y.invalid", apiKey: "yk" },
  moemail: { baseUrl: "https://m.invalid", apiKey: "mk" },
};

function put(env: EnvMap, key: string, value: string | undefined): void {
  // `undefined` = 这个键**压根不存在**（不是空串）。两者在装载器与
  // `configLoadBlockers` 里都是不同的分支，不能混。
  if (value !== undefined) env[key] = value;
}

/** ① 通道那张：`enabled` × 两侧 × 五种通道取值 × 凭据有无。 */
function channelGrid(): GridCase[] {
  const out: GridCase[] = [];
  for (const enabled of [true, false]) {
    for (const side of ["env", "stored"] as const) {
      for (const c of CHANNEL_VALUES) {
        for (const creds of [true, false]) {
          const env: EnvMap = {};
          const stored: Partial<RegistrarConfig> = creds ? { ...FULL_CREDS } : {};
          if (enabled) env.REGISTRAR_ENABLED = "true";
          else stored.enabled = false;
          if (side === "env") put(env, "REGISTRAR_CHANNEL", c);
          else if (c !== undefined) stored.channel = c as RegistrarConfig["channel"];
          out.push({
            name: `通道/${enabled ? "开" : "关"}/${side}/channel=${String(c)}/creds=${creds}`,
            env, stored,
          });
        }
      }
    }
  }
  return out;
}

/**
 * ② 存量旧键那张：`enabled` × 两侧 × 旧主通道五种 × 旧备通道五种 × 凭据有无。
 *
 * 喂的是**升级前那份配置的形状**：env 侧是 `REGISTRAR_PRIMARY` / `REGISTRAR_FALLBACK`
 * 两个旧变量名，存储侧是 `registrar.primary` / `registrar.fallback` 两个旧键。
 * 新名字一个都不给 —— 这一张就是要把「兼容读」那条路径叉满。
 */
function legacyGrid(): GridCase[] {
  const out: GridCase[] = [];
  for (const enabled of [true, false]) {
    for (const side of ["env", "stored"] as const) {
      for (const p of CHANNEL_VALUES) {
        for (const f of CHANNEL_VALUES) {
          for (const creds of [true, false]) {
            const env: EnvMap = {};
            const stored: Partial<RegistrarConfig> = creds ? { ...FULL_CREDS } : {};
            if (enabled) env.REGISTRAR_ENABLED = "true";
            else stored.enabled = false;
            if (side === "env") {
              put(env, "REGISTRAR_PRIMARY", p);
              put(env, "REGISTRAR_FALLBACK", f);
            } else {
              // 旧键已经不在 `RegistrarConfig` 上了，所以这里要绕过类型 —— 而这正是
              // 存量存储里真实存在的形状。
              if (p !== undefined) (stored as Record<string, unknown>).primary = p;
              if (f !== undefined) (stored as Record<string, unknown>).fallback = f;
            }
            out.push({
              name: `存量旧键/${enabled ? "开" : "关"}/${side}/primary=${String(p)}/fallback=${String(f)}/creds=${creds}`,
              env, stored,
            });
          }
        }
      }
    }
  }
  return out;
}

/** ③ 数值那张：三个代表性字段 × 两侧 × 六种取值，底座是一份跑得起来的配置。 */
function numberGrid(): GridCase[] {
  const fields = [
    { envName: "TARGET_KEYS", stored: "targetKeys" },
    { envName: "MINT_DELAY_MIN_MS", stored: "mintDelayMinMs" },
    { envName: "MINT_DELAY_MAX_MS", stored: "mintDelayMaxMs" },
  ] as const;
  const out: GridCase[] = [];
  for (const f of fields) {
    for (const side of ["env", "stored"] as const) {
      for (const v of NUM_VALUES) {
        const env: EnvMap = { REGISTRAR_ENABLED: "true", REGISTRAR_CHANNEL: "yyds" };
        const stored: Partial<RegistrarConfig> = { ...FULL_CREDS };
        if (side === "env") env[f.envName] = String(v);
        else (stored as Record<string, unknown>)[f.stored] = v;
        out.push({ name: `数值/${f.envName}/${side}/${String(v)}`, env, stored });
      }
    }
  }
  return out;
}

/** ④ 延迟对那张：`min` × `max`，两种「一边 env 一边存储」的摆法。 */
function delayGrid(): GridCase[] {
  const out: GridCase[] = [];
  for (const minOnEnv of [true, false]) {
    for (const min of NUM_VALUES) {
      for (const max of NUM_VALUES) {
        const env: EnvMap = {};
        const stored: Partial<RegistrarConfig> = {};
        if (minOnEnv) {
          env.MINT_DELAY_MIN_MS = String(min);
          (stored as Record<string, unknown>).mintDelayMaxMs = max;
        } else {
          (stored as Record<string, unknown>).mintDelayMinMs = min;
          env.MINT_DELAY_MAX_MS = String(max);
        }
        out.push({ name: `延迟/${minOnEnv ? "min@env" : "min@stored"}/${String(min)}>${String(max)}`, env, stored });
      }
    }
  }
  return out;
}

export function registrarGrid(): GridCase[] {
  return [...channelGrid(), ...legacyGrid(), ...numberGrid(), ...delayGrid()];
}
