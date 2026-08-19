/*
 * 全站唯一的经典脚本：<head> 里同步执行、**不许加 defer / type="module"**。
 *
 * 模块脚本天然 defer，会在 body 绘制之后才跑，于是每次刷新都能看见一次亮色闪白
 *（或一次错误的语言）。这条约束写在这里，改动前先读它。
 *
 * 它也是全站唯一允许在 CSS 之前加载的脚本——主题属性必须在样式表生效前落到
 * <html> 上，否则 :root[data-theme="dark"] 那一整组覆盖会晚一帧。
 */
(function () {
  try {
    var theme = localStorage.getItem("agnes2api_theme");
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    // light 时**移除属性**而不是设成 "light"：CSS 里 :root 是亮色全量 token，
    // [data-theme="dark"] 整体覆盖，多一个 light 值只会多一条永远匹配不上的规则。
    var lang = localStorage.getItem("agnes2api_lang") || "zh-CN";
    document.documentElement.setAttribute("data-lang", lang);
    document.documentElement.lang = lang;
  } catch (e) {
    // localStorage 被禁用（隐私模式 / 三方 cookie 拦截）时什么都不做，走默认外观。
    // 这里**不能抛**：它是同步脚本，抛出去会让后面的样式表和模块脚本一起停摆。
  }
})();
